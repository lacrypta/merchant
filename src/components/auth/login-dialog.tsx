"use client"

import * as React from "react"
import { ClipboardPaste, Puzzle, QrCode } from "lucide-react"

import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { NostrConnectHandle } from "@/lib/nostr/backend"

/**
 * Login dialog. Deliberately owns NO navigation.
 *
 * Its parent swaps branches the moment auth flips to `ready`, which unmounts
 * this component — so a redirect effect living here would never fire. The
 * caller decides where to go (see AccountMenu).
 */
export function LoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    state,
    extensionAvailable,
    loginExtension,
    loginBunker,
    startQrLogin,
    completeQrLogin,
  } = useAuth()

  const [bunkerUri, setBunkerUri] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [qr, setQr] = React.useState<NostrConnectHandle | null>(null)
  const busy = state.status === "connecting"


  /**
   * Tear down a pending QR handshake when the dialog closes.
   *
   * Done in the change handler rather than an effect: a synchronous setState
   * inside an effect body causes a cascading render, and closing is a
   * discrete user action, not state to synchronise.
   */
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && qr) {
        qr.cancel()
        setQr(null)
      }
      onOpenChange(next)
    },
    [qr, onOpenChange]
  )

  async function run(fn: () => Promise<void>) {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pudimos conectar.")
    }
  }

  function beginQr() {
    setError(null)
    const handle = startQrLogin()
    if (!handle) {
      setError("No pudimos iniciar la conexión remota.")
      return
    }
    setQr(handle)
    void run(() => completeQrLogin(handle))
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Ingresá con Nostr</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Tu catálogo se firma con tu clave. No guardamos tu nsec.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <Tabs defaultValue="extension" className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="extension" className="flex-1">
              <Puzzle className="size-4" aria-hidden /> Extensión
            </TabsTrigger>
            <TabsTrigger value="remote" className="flex-1">
              <QrCode className="size-4" aria-hidden /> Firmante remoto
            </TabsTrigger>
          </TabsList>

          <TabsContent value="extension" className="space-y-4">
            <Button
              fullWidth
              size="lg"
              disabled={busy}
              onClick={() => void run(loginExtension)}
            >
              {busy ? "Conectando…" : "Conectar extensión"}
            </Button>
            {!extensionAvailable ? (
              <p className="text-sm text-muted-foreground">
                No detectamos una extensión. Probá{" "}
                <a
                  href="https://getalby.com"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Alby
                </a>{" "}
                o nos2x, o usá un firmante remoto.
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="remote" className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="bunker-uri">Pegá tu enlace bunker://</Label>
              <div className="flex gap-2">
                <Input
                  id="bunker-uri"
                  value={bunkerUri}
                  onChange={(e) => setBunkerUri(e.target.value)}
                  placeholder="bunker://…"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Pegar desde el portapapeles"
                  onClick={async () => {
                    try {
                      setBunkerUri((await navigator.clipboard.readText()).trim())
                    } catch {
                      setError("No pudimos leer el portapapeles.")
                    }
                  }}
                >
                  <ClipboardPaste className="size-4" aria-hidden />
                </Button>
              </div>
              <Button
                fullWidth
                disabled={busy || !bunkerUri.trim()}
                onClick={() => void run(() => loginBunker(bunkerUri.trim()))}
              >
                {busy ? "Conectando…" : "Conectar bunker"}
              </Button>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />o<span className="h-px flex-1 bg-border" />
            </div>

            {qr ? (
              <QrPanel uri={qr.uri} />
            ) : (
              <Button
                fullWidth
                variant="outline"
                disabled={busy}
                onClick={beginQr}
              >
                Generar código QR
              </Button>
            )}
          </TabsContent>
        </Tabs>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/**
 * The nostrconnect:// URI as a scannable QR.
 *
 * Rendered on a white card with a quiet zone — a lime-on-black code does not
 * reliably scan with phone cameras.
 */
function QrPanel({ uri }: { uri: string }) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const QR = (await import("qrcode")).default
      const url = await QR.toDataURL(uri, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 512,
        color: { dark: "#0A0A0A", light: "#FFFFFF" },
      })
      if (!cancelled) setDataUrl(url)
    })()
    return () => {
      cancelled = true
    }
  }, [uri])

  return (
    <div className="space-y-3">
      <div className="mx-auto w-fit rounded-2xl bg-white p-3">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt="Código QR para conectar tu firmante remoto"
            className="size-[220px]"
          />
        ) : (
          <div className="size-[220px] animate-pulse rounded-lg bg-neutral-200" />
        )}
      </div>

      <p className="text-center text-sm text-muted-foreground">
        Escaneá con tu app de firma y aprobá la solicitud.
      </p>

      <Button
        fullWidth
        variant="ghost"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(uri)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? "Copiado" : "Copiar enlace"}
      </Button>
    </div>
  )
}
