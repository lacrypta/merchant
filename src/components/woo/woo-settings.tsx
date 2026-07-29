"use client"

import { ExternalLink, Loader2, Plug, Unplug } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TickerChip } from "@/components/ui/ticker-chip"
import { useWoo } from "@/components/woo/woo-provider"
import { normalizeStoreUrl } from "@/lib/domain/woo-config"
import { nowSeconds } from "@/lib/nostr/created-at"

export function WooSettings() {
  const { connection, state, canStore, connect, disconnect, error } = useWoo()

  if (state === "no-signer") {
    return (
      <>
        <PageHeader title="WooCommerce" />
        <Notice tone="muted">Ingresá con Nostr para conectar tu tienda.</Notice>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="WooCommerce"
        description="Importá tu catálogo, sincronizá el stock y mandá las ventas cobradas por Lightning a tu tienda."
        action={
          connection ? (
            <Button variant="ghost" onClick={() => void disconnect()}>
              <Unplug className="size-4" aria-hidden />
              Desconectar
            </Button>
          ) : null
        }
      />

      {!canStore ? (
        <Notice tone="warning">
          Tu firmante no puede cifrar (NIP-44), así que no podemos guardar la
          conexión en nostr. Probá con una extensión más nueva o un firmante
          remoto — la clave de tu tienda no puede viajar sin cifrar.
        </Notice>
      ) : null}

      {state === "cannot-decrypt" ? (
        <Notice tone="warning">
          Hay datos guardados que no pudimos descifrar. Puede ser otra
          aplicación usando el mismo espacio, así que no los vamos a pisar.
        </Notice>
      ) : null}

      {error ? <Notice tone="warning">{error}</Notice> : null}

      {connection ? (
        <ConnectedCard />
      ) : (
        <ManualConnectForm onConnect={connect} disabled={!canStore} />
      )}
    </>
  )
}

function ConnectedCard() {
  const { connection } = useWoo()
  if (!connection) return null

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <TickerChip tone="success">Conectada</TickerChip>
        <p className="truncate-middle numeric min-w-0 flex-1 text-sm">
          {connection.storeUrl}
        </p>
        <a
          href={`${connection.storeUrl}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          Ver claves
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <Detail label="Moneda de la tienda" value={connection.storeCurrency} />
        <Detail label="Permisos" value={connection.keyPermissions} />
        <Detail
          label="Clave"
          value={`${connection.consumerKey.slice(0, 9)}…`}
        />
      </dl>

      <p className="text-xs text-muted-foreground">
        La clave y el secreto están guardados cifrados en tu propio evento de
        nostr. Al desconectar los borramos de acá, pero acordate de revocar la
        clave en WooCommerce.
      </p>
    </section>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  )
}

function ManualConnectForm({
  onConnect,
  disabled,
}: {
  onConnect: (c: Parameters<ReturnType<typeof useWoo>["connect"]>[0]) => Promise<void>
  disabled: boolean
}) {
  const [storeUrl, setStoreUrl] = React.useState("")
  const [key, setKey] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setProblem(null)

    const url = normalizeStoreUrl(storeUrl)
    if (!url) {
      setProblem("La dirección tiene que ser https, con un dominio real.")
      return
    }

    setBusy(true)
    try {
      const res = await fetch("/api/woo/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storeUrl: url,
          consumerKey: key.trim(),
          consumerSecret: secret.trim(),
        }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        storeCurrency?: string
        error?: string
      }

      if (!res.ok || !data.ok || !data.storeCurrency) {
        setProblem(data.error ?? "No pudimos conectar con la tienda.")
        return
      }

      await onConnect({
        v: 1,
        storeUrl: url,
        consumerKey: key.trim(),
        consumerSecret: secret.trim(),
        keyPermissions: "read_write",
        storeCurrency: data.storeCurrency,
        connectedAt: nowSeconds(),
      })
      toast.success("Tienda conectada")
    } catch (err) {
      setProblem(
        err instanceof Error ? err.message : "No pudimos guardar la conexión."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="space-y-2">
          <Label htmlFor="woo-url">Dirección de la tienda</Label>
          <Input
            id="woo-url"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            placeholder="https://mitienda.com"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="woo-key">Consumer key</Label>
            <Input
              id="woo-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="ck_…"
              autoComplete="off"
              spellCheck={false}
              className="numeric"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="woo-secret">Consumer secret</Label>
            <Input
              id="woo-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="cs_…"
              autoComplete="off"
              spellCheck={false}
              className="numeric"
            />
          </div>
        </div>

        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || disabled}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Probando…
            </>
          ) : (
            <>
              <Plug className="size-4" aria-hidden />
              Conectar
            </>
          )}
        </Button>
      </section>

      <section className="space-y-2 rounded-xl border border-border bg-surface-2 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Cómo sacar la clave</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>En tu WordPress, andá a WooCommerce → Ajustes → Avanzado → API REST.</li>
          <li>Tocá «Crear una clave de API».</li>
          <li>Elegí tu usuario y permisos «Lectura/Escritura».</li>
          <li>Copiá la clave y el secreto acá. El secreto se muestra una sola vez.</li>
        </ol>
      </section>
    </form>
  )
}

function Notice({
  tone,
  children,
}: {
  tone: "warning" | "muted"
  children: React.ReactNode
}) {
  return (
    <p
      className={
        tone === "warning"
          ? "rounded-xl border border-warning/30 bg-warning-bg p-4 text-sm text-warning"
          : "rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
      }
    >
      {children}
    </p>
  )
}
