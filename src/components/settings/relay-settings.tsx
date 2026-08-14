"use client"

import * as React from "react"
import { Plus, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { PageHeader } from "@/components/shell/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { TickerChip } from "@/components/ui/ticker-chip"
import type { RelayEntry } from "@/lib/domain/relay-list"
import { relayStatuses } from "@/lib/nostr/backend"
import {
  DEFAULT_RELAYS,
  isReadOnlyByDefault,
  normalizeRelayUrl,
} from "@/lib/nostr/relays"
import { RELAY_SUGGESTIONS } from "@/lib/nostr/relay-suggestions"

const SOURCE_LABEL: Record<RelayEntry["source"], string> = {
  nip65: "NIP-65",
  default: "por defecto",
  manual: "manual",
}

export function RelaySettings() {
  const {
    relayEntries,
    setRelayEntries,
    publishRelayList,
    loading,
    syncCatalog,
    replaying,
    saving,
  } = useCatalog()
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<Record<string, boolean>>({})

  const urls = React.useMemo(
    () => relayEntries.map((e) => e.url).join(","),
    [relayEntries]
  )

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = urls ? urls.split(",") : []
      if (list.length === 0) return
      const s = await relayStatuses(list)
      if (!cancelled) setStatus(s)
    })()
    return () => {
      cancelled = true
    }
  }, [urls])

  const writeCount = relayEntries.filter((e) => e.write).length
  const known = new Set(relayEntries.map((e) => e.url))
  const suggestions = RELAY_SUGGESTIONS.filter((s) => {
    const n = normalizeRelayUrl(s.url)
    return n !== null && !known.has(n)
  })

  function add(url: string) {
    const normalized = normalizeRelayUrl(url)
    if (!normalized) {
      setError("Tiene que ser una URL wss://")
      return
    }
    if (relayEntries.some((e) => e.url === normalized)) {
      setError("Ese relay ya está en la lista")
      return
    }
    setError(null)
    setDraft("")
    setRelayEntries([
      ...relayEntries,
      {
        url: normalized,
        read: true,
        write: !isReadOnlyByDefault(normalized),
        source: "manual",
      },
    ])
  }

  function update(url: string, patch: Partial<RelayEntry>) {
    setRelayEntries(
      relayEntries.map((e) => (e.url === url ? { ...e, ...patch } : e))
    )
  }

  function remove(url: string) {
    setRelayEntries(relayEntries.filter((e) => e.url !== url))
  }

  return (
    <>
      <PageHeader
        title="Relays"
        count={relayEntries.length}
        description="Dónde se leen y se publican tus productos. Se guarda en nostr como una lista NIP-65 (kind 10002)."
      />

      {writeCount === 0 ? (
        <p
          role="alert"
          className="mb-6 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          Sin relays de escritura no vas a poder publicar nada.
        </p>
      ) : null}

      <ul className="max-w-panel space-y-2">
        {relayEntries.map((entry) => (
          <li
            key={entry.url}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${
                status[entry.url] ? "bg-success" : "bg-surface-4"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate-middle numeric text-sm">{entry.url}</p>
              <p className="text-xs text-muted-foreground">
                {status[entry.url] ? "Conectado" : "Sin conexión"}
                <span aria-hidden> · </span>
                {SOURCE_LABEL[entry.source]}
              </p>
            </div>

            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={entry.read}
                onCheckedChange={(v) => update(entry.url, { read: v })}
                aria-label={`Leer de ${entry.url}`}
              />
              Leer
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={entry.write}
                onCheckedChange={(v) => update(entry.url, { write: v })}
                aria-label={`Escribir en ${entry.url}`}
              />
              Escribir
            </label>

            <Button
              variant="ghost"
              size="icon-sm"
              className="tap-44"
              aria-label={`Quitar ${entry.url}`}
              onClick={() => remove(entry.url)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-6 max-w-panel space-y-2">
        <Label htmlFor="relay-add">Agregar relay</Label>
        <div className="flex gap-2">
          <Input
            id="relay-add"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                add(draft)
              }
            }}
            placeholder="wss://relay.ejemplo.com"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!error}
            className="numeric"
          />
          <Button type="button" onClick={() => add(draft)}>
            <Plus className="size-4" aria-hidden />
            Agregar
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <section className="mt-10 max-w-panel">
          <h2 className="text-h3 mb-1">Relays populares</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Cuantos más relays, más difícil es que tu catálogo desaparezca.
          </p>
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li
                key={s.url}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border-strong p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {s.label}{" "}
                    <span className="numeric text-xs font-normal text-muted-foreground">
                      {s.url}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{s.note}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => add(s.url)}
                >
                  <Plus className="size-4" aria-hidden />
                  Agregar
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-10 flex max-w-panel flex-wrap items-center gap-3 border-t border-border pt-6">
        <Button disabled={loading} onClick={publishRelayList}>
          <Upload className="size-4" aria-hidden />
          Publicar mi lista (NIP-65)
        </Button>

        <Button
          variant="outline"
          disabled={loading || replaying || saving || writeCount === 0}
          onClick={() => syncCatalog()}
        >
          <RefreshCw
            className={`size-4 ${replaying ? "motion-safe:animate-spin" : ""}`}
            aria-hidden
          />
          Sincronizar
        </Button>

        <Button
          variant="ghost"
          onClick={() =>
            setRelayEntries(
              DEFAULT_RELAYS.map((url) => ({
                url,
                read: true,
                write: !isReadOnlyByDefault(url),
                source: "default" as const,
              }))
            )
          }
        >
          <RotateCcw className="size-4" aria-hidden />
          Restaurar predeterminados
        </Button>

        <TickerChip>
          <b className="text-primary">{writeCount}</b> de {relayEntries.length}{" "}
          escriben
        </TickerChip>
      </div>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        Publicar tu lista hace que otros clientes sepan dónde encontrarte. Si
        sacás <code>relay.lacrypta.ar</code>, puede que el POS de La Crypta deje
        de ver tu catálogo.
      </p>
      <p className="mt-2 max-w-prose text-xs text-muted-foreground">
        <b className="text-foreground">Sincronizar</b> reenvía productos,
        categorías y el anuncio de cupones a cada relay de escritura que no los
        tenga. Va despacio a propósito, para que los relays no te bloqueen la
        clave. Al agregar un relay de escritura, esa copia se hace sola.
      </p>

      <div className="mt-6">
        <Badge variant="secondary">
          Los cambios se guardan en este dispositivo al instante
        </Badge>
      </div>
    </>
  )
}
