"use client"

import * as React from "react"
import {
  CircleCheck,
  CloudUpload,
  ImagePlus,
  Loader2,
  Trash2,
} from "lucide-react"

import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  blossomServerHostname,
  POPULAR_BLOSSOM_SERVERS,
  uploadImageToBlossom,
  validateProductImage,
  type BlossomUploadPhase,
} from "@/lib/blossom/upload"
import type { ProductImage } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

type UploadState =
  | { status: "idle" }
  | {
      status: "uploading"
      phase: BlossomUploadPhase
      percent: number
      server?: string
    }
  | { status: "success"; server: string }
  | { status: "error"; message: string }

export function ProductImageUpload({
  value,
  onChange,
  onBusyChange,
  validationError,
  title = "Imagen del producto",
  alt = "Vista previa del producto",
}: {
  value: ProductImage | null
  onChange: (image: ProductImage | null) => void
  onBusyChange: (busy: boolean) => void
  validationError?: string
  /** Heading once an image is set. Coupons reuse this uploader verbatim. */
  title?: string
  alt?: string
}) {
  const { signer } = useAuth()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const localPreviewRef = React.useRef<string | null>(null)
  const [localPreview, setLocalPreview] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [upload, setUpload] = React.useState<UploadState>({ status: "idle" })

  React.useEffect(
    () => () => {
      abortRef.current?.abort()
      if (localPreviewRef.current) {
        URL.revokeObjectURL(localPreviewRef.current)
      }
    },
    []
  )

  const busy = upload.status === "uploading"
  const previewUrl = localPreview ?? value?.url ?? null

  async function startUpload(file: File) {
    const validation = validateProductImage(file)
    if (validation) {
      setUpload({ status: "error", message: validation })
      return
    }
    if (!signer) {
      setUpload({
        status: "error",
        message: "Ingresá con Nostr antes de subir una imagen.",
      })
      return
    }

    abortRef.current?.abort()
    if (localPreviewRef.current) {
      URL.revokeObjectURL(localPreviewRef.current)
    }

    const objectUrl = URL.createObjectURL(file)
    localPreviewRef.current = objectUrl
    setLocalPreview(objectUrl)

    const controller = new AbortController()
    abortRef.current = controller
    onBusyChange(true)

    try {
      const dimensions = readImageDimensions(objectUrl)
      const descriptor = await uploadImageToBlossom(
        file,
        signer,
        (progress) => {
          setUpload({ status: "uploading", ...progress })
        },
        controller.signal
      )
      const { width, height } = await dimensions

      onChange({
        url: descriptor.url,
        width,
        height,
        order: 0,
      })
      setUpload({
        status: "success",
        server: new URL(descriptor.url).origin,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setLocalPreview(null)
      if (localPreviewRef.current) {
        URL.revokeObjectURL(localPreviewRef.current)
        localPreviewRef.current = null
      }
      setUpload({
        status: "error",
        message: uploadErrorMessage(error),
      })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      onBusyChange(false)
    }
  }

  function removeImage() {
    abortRef.current?.abort()
    abortRef.current = null
    if (localPreviewRef.current) {
      URL.revokeObjectURL(localPreviewRef.current)
      localPreviewRef.current = null
    }
    setLocalPreview(null)
    setUpload({ status: "idle" })
    onBusyChange(false)
    onChange(null)
  }

  function openPicker() {
    inputRef.current?.click()
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card transition-[border-color,background-color]",
        dragging ? "border-primary bg-primary/5" : "border-border-strong",
        validationError || upload.status === "error"
          ? "border-danger/70"
          : null
      )}
      aria-busy={busy}
      onDragEnter={(event) => {
        event.preventDefault()
        if (!busy) setDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (!busy) {
          const file = event.dataTransfer.files[0]
          if (file) void startUpload(file)
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void startUpload(file)
        }}
      />

      <div className="grid min-h-36 grid-cols-[7.5rem_minmax(0,1fr)]">
        <div className="relative overflow-hidden border-r border-border bg-surface-3">
          {previewUrl ? (
            // Blob previews and arbitrary Blossom hosts cannot use next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={alt}
              className="size-full object-cover"
            />
          ) : (
            <div className="grid-flat flex size-full items-center justify-center">
              <ImagePlus
                className="size-8 text-muted-foreground"
                aria-hidden
              />
            </div>
          )}

          {busy ? (
            <div className="absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-[2px]">
              <Loader2 className="size-7 animate-spin text-primary" aria-hidden />
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-3 p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">
              {previewUrl ? title : "Subí una imagen"}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              JPG, PNG, WebP, GIF o AVIF · máximo 10 MB
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tap-44"
              disabled={busy}
              onClick={openPicker}
            >
              <CloudUpload aria-hidden />
              {previewUrl ? "Reemplazar" : "Elegir imagen"}
            </Button>
            {previewUrl && !busy ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="tap-44 text-muted-foreground hover:text-danger"
                aria-label="Quitar imagen"
                onClick={removeImage}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </div>

          {upload.status === "idle" ? (
            <p className="text-[0.6875rem] text-muted-foreground">
              Blossom automático · {POPULAR_BLOSSOM_SERVERS.length} servidores
              de respaldo
            </p>
          ) : null}
        </div>
      </div>

      {upload.status === "uploading" ? (
        <div
          className="space-y-2 border-t border-border bg-surface-2 px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-primary"
                aria-hidden
              />
              <span className="truncate">{progressLabel(upload)}</span>
            </span>
            <span className="numeric shrink-0 text-muted-foreground">
              {Math.round(upload.percent)}%
            </span>
          </div>
          <Progress
            value={upload.percent}
            aria-label="Progreso de subida de imagen"
          />
        </div>
      ) : null}

      {upload.status === "success" ? (
        <div
          className="flex items-center gap-2 border-t border-success/30 bg-success-bg px-4 py-2.5 text-xs text-success"
          role="status"
          aria-live="polite"
        >
          <CircleCheck className="size-4 shrink-0" aria-hidden />
          Guardada en {blossomServerHostname(upload.server)}
        </div>
      ) : null}

      {upload.status === "error" || validationError ? (
        <p
          className="border-t border-danger/30 bg-danger-bg px-4 py-2.5 text-xs text-danger"
          role="alert"
        >
          {upload.status === "error" ? upload.message : validationError}
        </p>
      ) : null}
    </div>
  )
}

function progressLabel(upload: Extract<UploadState, { status: "uploading" }>) {
  if (upload.phase === "hashing") return "Preparando imagen"
  if (upload.phase === "signing") return "Esperando tu firma"
  return upload.server
    ? `Subiendo a ${blossomServerHostname(upload.server)}`
    : "Subiendo a Blossom"
}

function readImageDimensions(url: string): Promise<{
  width: number
  height: number
}> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth || 256,
        height: image.naturalHeight || 256,
      })
    }
    image.onerror = () => resolve({ width: 256, height: 256 })
    image.src = url
  })
}

function uploadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (/reject|denied|cancel/i.test(message)) {
    return "La firma fue rechazada. Elegí la imagen y probá de nuevo."
  }
  return "No pudimos subir la imagen a Blossom. Probá de nuevo."
}
