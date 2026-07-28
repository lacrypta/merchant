"use client"

import { Radio } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { summarise, useRelayLog } from "@/lib/nostr/relay-log"
import { DEFAULT_RELAYS } from "@/lib/nostr/relays"
import {
  isRelayEnabled,
  setRelayEnabled,
  useRelayPrefs,
} from "@/lib/nostr/relay-prefs"
import { cn } from "@/lib/utils"

/**
 * How many relays answered for THIS page, and what each one gave us.
 *
 * Sits to the left of the account control on every page. It is the honest
 * answer to "is this actually decentralised, and is it working" — a question
 * a nostr app should never make you open devtools to answer.
 *
 * Hidden when nothing has been read yet, so a static page carries no dead
 * chrome.
 */
export function RelayLogButton() {
  const log = useRelayLog()
  const prefs = useRelayPrefs()
  const [open, setOpen] = React.useState(false)
  const summary = summarise(log, (r) => isRelayEnabled(r, prefs))

  if (summary.total === 0) return null

  const allGood = summary.connected === summary.total
  const none = summary.connected === 0

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Relays: ${summary.connected} de ${summary.total} respondieron`}
        className="gap-1.5 px-2.5"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            none ? "bg-danger" : allGood ? "bg-success" : "bg-warning"
          )}
        />
        <Radio className="size-4" aria-hidden />
        <span className="numeric text-xs">
          {summary.connected}/{summary.total}
        </span>
      </Button>

      <RelayLogDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function RelayLogDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const log = useRelayLog()
  const prefs = useRelayPrefs()
  const summary = summarise(log, (r) => isRelayEnabled(r, prefs))

  // One row per relay, with its reads folded in — the question is "what did
  // THIS relay do", not "what happened in chronological order".
  //
  // Seeded with every relay we know about, NOT just the ones in the log. A
  // relay switched off makes no reads, so a log-only list would drop its row
  // — and the row holds the only switch that turns it back on.
  const byRelay = React.useMemo(() => {
    const map = new Map<string, typeof log>()
    for (const url of DEFAULT_RELAYS) map.set(url, [])
    for (const e of prefs) map.set(e.url, map.get(e.url) ?? [])
    for (const e of log) {
      const list = map.get(e.relay) ?? []
      list.push(e)
      map.set(e.relay, list)
    }
    return [...map.entries()].sort((a, b) => {
      const ea = a[1].reduce((n, x) => n + x.events, 0)
      const eb = b[1].reduce((n, x) => n + x.events, 0)
      return eb - ea || a[0].localeCompare(b[0])
    })
  }, [log, prefs])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Relays</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            De dónde salieron los datos de esta página.{" "}
            <b className="text-foreground">
              {summary.connected}/{summary.total}
            </b>{" "}
            respondieron · <span className="numeric">{summary.events}</span>{" "}
            {summary.events === 1 ? "evento" : "eventos"} ·{" "}
            <span className="numeric">{formatBytes(summary.bytes)}</span>
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ul className="space-y-2">
          {byRelay.map(([relay, reads]) => {
            const events = reads.reduce((n, r) => n + r.events, 0)
            const bytes = reads.reduce((n, r) => n + r.bytes, 0)
            const answered = reads.some(
              (r) => r.status === "ok" || r.status === "empty"
            )
            // We stopped waiting; the relay never got the chance to finish.
            const cut = !answered && reads.some((r) => r.status === "cut")
            const unread = reads.length === 0
            const ms = reads.length > 0 ? Math.max(...reads.map((r) => r.ms)) : 0
            const on = isRelayEnabled(relay, prefs)
            // Server-rendered pages fan out from the server, which cannot see
            // this browser's switches. Saying only "desactivado" next to a
            // fresh 72-event read would be a flat contradiction.
            const readAnyway = !on && reads.some((r) => r.origin === "server")
            return (
              <li
                key={relay}
                className={cn(
                  "enter-row rounded-xl border border-border bg-card p-3 transition-opacity duration-200",
                  !on && "opacity-50"
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    checked={on}
                    onCheckedChange={(v) => setRelayEnabled(relay, v)}
                    aria-label={`${on ? "Dejar de usar" : "Usar"} ${relay}`}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      !on || unread
                        ? "bg-surface-4"
                        : events > 0
                          ? "bg-success"
                          : answered
                            ? "bg-surface-4"
                            : cut
                              ? "bg-warning"
                              : "bg-danger"
                    )}
                  />
                  <p className="truncate-middle numeric min-w-0 flex-1 text-sm">
                    {relay}
                  </p>
                  {reads.length > 0 && (
                    <span className="numeric shrink-0 text-xs text-muted-foreground">
                      {ms} ms
                    </span>
                  )}
                  <span
                    className={cn(
                      "numeric shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                      !on || unread
                        ? "border-border-strong text-muted-foreground"
                        : events > 0
                          ? "border-success/30 bg-success-bg text-success"
                          : answered
                            ? "border-border-strong text-muted-foreground"
                            : cut
                              ? "border-warning/30 bg-warning-bg text-warning"
                              : "border-danger/40 bg-danger-bg text-danger"
                    )}
                  >
                    {!on
                      ? readAnyway
                        ? "desactivado · lo leyó el servidor"
                        : "desactivado"
                      : unread
                        ? "sin consultar"
                        : events > 0
                          ? `${events} ev · ${formatBytes(bytes)}`
                          : answered
                            ? "sin datos"
                            : cut
                              ? "cortado"
                              : "sin respuesta"}
                  </span>
                </div>

                <ul className="mt-2 space-y-0.5 pl-4">
                  {reads.map((r, i) => (
                    <li
                      key={`${r.label}-${i}`}
                      className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">
                        · {r.label}
                      </span>
                      <span className="numeric shrink-0">
                        {r.status === "timeout"
                          ? "sin respuesta"
                          : r.status === "cut" && r.events === 0
                            ? "cortado"
                            : `${r.events} ev · ${formatBytes(r.bytes)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          Se consulta a todos los relays a la vez y los eventos se deduplican
          por id, así que la suma de arriba es mayor que lo que ves en pantalla.
          <b className="text-foreground"> Cortado</b> quiere decir que dejamos
          de esperarlo una vez que ya teníamos los datos — no que haya fallado.
          Y un relay sin datos tampoco es un error: no todos guardan todo.
          <br />
          <br />
          El interruptor deja de usar ese relay en{" "}
          <b className="text-foreground">este navegador</b>: no se lee ni se
          publica ahí. Es el mismo registro que Ajustes → Relays, donde podés
          separar «Leer» de «Escribir». Las tiendas públicas se arman en el
          servidor, con la lista de relays del servidor, así que este ajuste no
          las cambia — por eso un relay apagado puede seguir apareciendo ahí
          con datos.
        </p>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
