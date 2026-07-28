import type { SignerPort } from "@/lib/nostr/types"
import { nowSeconds } from "@/lib/nostr/created-at"

/**
 * Public Blossom servers with working browser CORS support.
 *
 * Uploads try them in order. A BUD-11 token is scoped to this exact set of
 * hostnames, so it cannot be replayed against an unrelated Blossom server.
 */
export const POPULAR_BLOSSOM_SERVERS = [
  "https://blossom.band",
  "https://cdn.satellite.earth",
  "https://blossom.primal.net",
] as const

export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024

export const PRODUCT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const

export interface BlossomBlobDescriptor {
  url: string
  sha256: string
  size: number
  type: string
  uploaded: number
}

export type BlossomUploadPhase = "hashing" | "signing" | "uploading"

export interface BlossomUploadProgress {
  phase: BlossomUploadPhase
  /** 0–100; hashing/signing use small fixed waypoints. */
  percent: number
  server?: string
}

export function validateProductImage(file: File): string | null {
  if (
    !PRODUCT_IMAGE_TYPES.includes(
      file.type as (typeof PRODUCT_IMAGE_TYPES)[number]
    )
  ) {
    return "Usá una imagen JPG, PNG, WebP, GIF o AVIF."
  }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    return "La imagen puede pesar hasta 10 MB."
  }
  if (file.size === 0) {
    return "La imagen está vacía."
  }
  return null
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export function blossomServerHostname(server: string): string {
  return new URL(server).hostname.toLowerCase()
}

export async function createBlossomUploadAuthorization(
  signer: SignerPort,
  sha256: string,
  servers: readonly string[],
  now = nowSeconds()
): Promise<string> {
  const signed = await signer.signEvent({
    kind: 24242,
    created_at: now - 1,
    content: "Upload product image",
    tags: [
      ["t", "upload"],
      ["expiration", String(now + 5 * 60)],
      ["x", sha256],
      ...servers.map((server) => ["server", blossomServerHostname(server)]),
    ],
  })

  return `Nostr ${base64UrlEncode(JSON.stringify(signed))}`
}

export function parseBlossomBlobDescriptor(
  value: unknown,
  expectedSha256: string
): BlossomBlobDescriptor {
  if (!value || typeof value !== "object") {
    throw new Error("Blossom devolvió una respuesta inválida.")
  }

  const descriptor = value as Partial<BlossomBlobDescriptor>
  if (
    typeof descriptor.url !== "string" ||
    typeof descriptor.sha256 !== "string"
  ) {
    throw new Error("Blossom no devolvió la URL de la imagen.")
  }

  const sha256 = descriptor.sha256.toLowerCase()
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error("El servidor devolvió un hash distinto al archivo.")
  }

  const url = new URL(descriptor.url)
  if (url.protocol !== "https:") {
    throw new Error("Blossom devolvió una URL no segura.")
  }

  return {
    url: url.toString(),
    sha256,
    size:
      typeof descriptor.size === "number" && descriptor.size >= 0
        ? descriptor.size
        : 0,
    type:
      typeof descriptor.type === "string"
        ? descriptor.type
        : "application/octet-stream",
    uploaded:
      typeof descriptor.uploaded === "number"
        ? descriptor.uploaded
        : nowSeconds(),
  }
}

export async function uploadImageToBlossom(
  file: File,
  signer: SignerPort,
  onProgress: (progress: BlossomUploadProgress) => void,
  signal?: AbortSignal,
  servers: readonly string[] = POPULAR_BLOSSOM_SERVERS
): Promise<BlossomBlobDescriptor> {
  signal?.throwIfAborted()
  onProgress({ phase: "hashing", percent: 6 })
  const sha256 = await sha256Hex(file)

  signal?.throwIfAborted()
  onProgress({ phase: "signing", percent: 12 })
  const authorization = await createBlossomUploadAuthorization(
    signer,
    sha256,
    servers
  )

  const failures: string[] = []
  for (const server of servers) {
    signal?.throwIfAborted()
    onProgress({ phase: "uploading", percent: 15, server })
    try {
      return await uploadToServer(
        file,
        server,
        sha256,
        authorization,
        (sent, total) => {
          const fraction = total > 0 ? sent / total : 0
          onProgress({
            phase: "uploading",
            percent: Math.min(99, Math.round(15 + fraction * 84)),
            server,
          })
        },
        signal
      )
    } catch (error) {
      if (signal?.aborted) throw error
      failures.push(
        `${blossomServerHostname(server)}: ${
          error instanceof Error ? error.message : "falló"
        }`
      )
    }
  }

  throw new Error(failures.join(" · "))
}

function uploadToServer(
  file: File,
  server: string,
  sha256: string,
  authorization: string,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal
): Promise<BlossomBlobDescriptor> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()

    xhr.open("PUT", `${server.replace(/\/$/, "")}/upload`)
    xhr.timeout = 45_000
    xhr.setRequestHeader("Authorization", authorization)
    xhr.setRequestHeader("Content-Type", file.type)
    xhr.setRequestHeader("X-SHA-256", sha256)

    xhr.upload.onprogress = (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    }

    xhr.onload = () => {
      signal?.removeEventListener("abort", abort)
      if (xhr.status !== 200 && xhr.status !== 201) {
        const reason = xhr.getResponseHeader("X-Reason")
        reject(
          new Error(
            reason?.trim() || `El servidor respondió con estado ${xhr.status}.`
          )
        )
        return
      }

      try {
        resolve(
          parseBlossomBlobDescriptor(JSON.parse(xhr.responseText), sha256)
        )
      } catch (error) {
        reject(error)
      }
    }

    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort)
      reject(new Error("No se pudo conectar."))
    }
    xhr.ontimeout = () => {
      signal?.removeEventListener("abort", abort)
      reject(new Error("La subida tardó demasiado."))
    }
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abort)
      reject(new DOMException("Upload aborted", "AbortError"))
    }

    signal?.addEventListener("abort", abort, { once: true })
    xhr.send(file)
  })
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
