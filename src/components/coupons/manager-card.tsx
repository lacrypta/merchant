"use client"

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Loader2,
  Radio,
  RefreshCw,
  Satellite,
  SatelliteDish,
  X,
} from "lucide-react"
import { nip19 } from "nostr-tools"
import * as React from "react"

import type {
  ActivationProgress,
  CouponService,
  CouponServiceState,
  DiscoveryPresence,
} from "@/components/coupons/use-coupon-service"
import type { RelayCheck } from "@/components/coupons/use-relay-check"
import { CopyButton } from "@/components/ui/copy-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import type { SignedEvent } from "@/lib/nostr/types"
import { cn } from "@/lib/utils"

/**
 * Activate this service as the merchant's coupon manager, and show the proof.
 *
 * Framed as "activar el servicio" rather than "publicar un evento" because that
 * is what the merchant is deciding: from here on, this backend issues coupons on
 * their behalf and any till can find it.
 *
 * The event itself is still shown, in full, because when a POS cannot see a
 * merchant's coupons this card is where both of them will look — and "it says
 * activated" is not an answer. The id, the date, the endpoints and where the
 * copies live are the answer.
 */
export function ManagerCard({ service }: { service: CouponService }) {
  const { state, presence, activating, activate, progress, saveError } = service
  const actionable =
    state.kind === "inactive" || state.kind === "outdated" || state.kind === "unreadable"
  const event = "event" in state ? state.event : null

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Radio className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            Servicio de cupones
            <StatusBadge state={state} />
          </h2>
          {progress ? <ActivationBar progress={progress} /> : <Body state={state} />}
        </div>

        <div className="shrink-0">
          {actionable || activating ? (
            <Button size="sm" disabled={activating} onClick={activate}>
              {activating ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Activando…
                </>
              ) : state.kind === "inactive" ? (
                "Activar servicio"
              ) : (
                "Reactivar"
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {saveError ? (
        <p role="alert" className="text-sm text-warning">
          {saveError}
        </p>
      ) : null}

      {event && state.kind !== "unreadable" ? (
        <EventDetails
          event={event}
          mintUrl={
            state.kind === "active" || state.kind === "outdated"
              ? state.published.mintUrl
              : null
          }
          claimUrl={
            state.kind === "active" || state.kind === "outdated"
              ? state.published.claimUrl
              : null
          }
          managerPubkey={
            state.kind === "active" || state.kind === "outdated"
              ? state.published.managerPubkey
              : null
          }
          presence={presence}
        />
      ) : null}
    </section>
  )
}

function StatusBadge({ state }: { state: CouponServiceState }) {
  switch (state.kind) {
    case "active":
      return (
        <Badge className="border-success/40 bg-success-bg text-success" variant="outline">
          Activado
        </Badge>
      )
    case "inactive":
    case "unavailable":
      return <Badge variant="outline">Desactivado</Badge>
    case "outdated":
    case "unreadable":
      return (
        <Badge className="border-warning/40 bg-warning-bg text-warning" variant="outline">
          Revisar
        </Badge>
      )
    case "loading":
      return null
  }
}

function Body({ state }: { state: CouponServiceState }) {
  switch (state.kind) {
    case "loading":
      return <p className="text-sm text-muted-foreground">Consultando el servidor…</p>

    case "unavailable":
      return (
        <p className="text-sm text-warning">
          {state.message} Configurá <code className="numeric">COUPON_MANAGER_NSEC</code> y{" "}
          <code className="numeric">DATABASE_URL</code> en el servidor para poder activarlo.
        </p>
      )

    case "inactive":
      return (
        <p className="text-sm text-muted-foreground">
          Activalo para que este servidor emita cupones a tu nombre y cualquier punto
          de venta pueda canjearlos. Hasta entonces no vas a poder crear cupones.
        </p>
      )

    case "active":
      return (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Este servidor emite tus cupones.
        </p>
      )

    case "outdated":
      return (
        <p className="flex items-start gap-1.5 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Tu anuncio apunta a{" "}
            <span className="truncate-middle numeric">{state.published.mintUrl}</span>, no
            a este servidor. Reactivalo acá para que los emita este.
          </span>
        </p>
      )

    case "unreadable":
      return (
        <p className="flex items-start gap-1.5 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            No pudimos leer el anuncio publicado ({state.reason}). Reactivalo para
            reemplazarlo.
          </span>
        </p>
      )
  }
}

/**
 * Real progress, not a decoration: the fraction is relay ACKs actually
 * received. `indeterminate` covers the stretches where there is genuinely
 * nothing to measure — queued, or waiting on a signature — and pulses instead
 * of implying precision.
 */
function ActivationBar({ progress }: { progress: ActivationProgress }) {
  return (
    <div className="space-y-1.5 pt-0.5">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {progress.label}
      </p>
      <Progress
        value={progress.percent}
        aria-label="Progreso de la publicación"
        className={cn("max-w-sm", progress.indeterminate && "animate-pulse")}
      />
    </div>
  )
}

function EventDetails({
  event,
  mintUrl,
  claimUrl,
  managerPubkey,
  presence,
}: {
  event: SignedEvent
  mintUrl: string | null
  claimUrl: string | null
  managerPubkey: string | null
  presence: DiscoveryPresence
}) {
  const [rawOpen, setRawOpen] = React.useState(false)

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap gap-2">
        <PresenceChip
          ok={presence.savedOnServer}
          icon={Database}
          okLabel="Guardado en el servidor"
          pendingLabel="No guardado acá"
        />
        <RelayChip presence={presence} />
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <Row label="Evento">
          <span className="flex items-center gap-1.5">
            <span className="truncate-middle numeric">{event.id}</span>
            <CopyButton value={event.id} label="Copiar el id del evento" />
          </span>
        </Row>
        <Row label="Firmado">
          <span className="numeric">
            {new Date(event.created_at * 1000).toLocaleString("es-AR")}
          </span>
        </Row>
        {mintUrl ? (
          <Row label="Emisión">
            <span className="truncate-middle numeric">{mintUrl}</span>
          </Row>
        ) : null}
        {claimUrl ? (
          <Row label="Canje">
            <span className="truncate-middle numeric">{claimUrl}</span>
          </Row>
        ) : null}
        {managerPubkey ? (
          <Row label="Firma los cupones">
            <span className="truncate-middle numeric">{safeNpub(managerPubkey)}</span>
          </Row>
        ) : null}
      </dl>

      <div>
        <p className="text-xs font-medium text-muted-foreground">En qué relays está</p>
        <RelayList checks={presence.relays} />
      </div>

      <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <ChevronDown
              className={cn("size-3.5 transition-transform", rawOpen && "rotate-180")}
              aria-hidden
            />
            {rawOpen ? "Ocultar" : "Ver"} el JSON del evento
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* The raw event, for whoever is wiring a POS against this merchant. */}
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-3 p-3 text-[0.6875rem] leading-relaxed">
            {JSON.stringify(event, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function PresenceChip({
  ok,
  icon: Icon,
  okLabel,
  pendingLabel,
}: {
  ok: boolean
  icon: typeof Database
  okLabel: string
  pendingLabel: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        ok
          ? "border-success/40 bg-success-bg text-success"
          : "border-border text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {ok ? okLabel : pendingLabel}
    </span>
  )
}

function RelayChip({ presence }: { presence: DiscoveryPresence }) {
  const { summary, found, total } = presence
  const map = {
    checking: {
      icon: Loader2,
      label: "Buscando en tus relays…",
      className: "border-border text-muted-foreground",
      spin: true,
    },
    republishing: {
      icon: RefreshCw,
      label: "Publicando en los que faltan…",
      className: "border-warning/40 bg-warning-bg text-warning",
      spin: true,
    },
    all: {
      icon: SatelliteDish,
      label: total === 1 ? "En tu relay" : `En tus ${total} relays`,
      className: "border-success/40 bg-success-bg text-success",
      spin: false,
    },
    partial: {
      icon: Satellite,
      label: `En ${found} de ${total} relays`,
      className: "border-warning/40 bg-warning-bg text-warning",
      spin: false,
    },
    none: {
      icon: Satellite,
      label: total === 0 ? "Sin relays de escritura" : "En ningún relay",
      className: "border-warning/40 bg-warning-bg text-warning",
      spin: false,
    },
  }[summary]

  const Icon = map.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        map.className
      )}
    >
      <Icon className={cn("size-3.5", map.spin && "animate-spin")} aria-hidden />
      {map.label}
    </span>
  )
}

/**
 * Which relays hold the announcement, one row each.
 *
 * This is the answer to "why can that POS not see my coupons": it is never the
 * whole network, it is one relay in the list that never got the event.
 */
function RelayList({ checks }: { checks: RelayCheck[] }) {
  if (checks.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        No tenés relays de escritura configurados.
      </p>
    )
  }

  return (
    <ul className="mt-2 space-y-1">
      {checks.map((c) => {
        const style = RELAY_ROW[c.state]
        const Icon = style.icon
        return (
          <li
            key={c.relay}
            className="flex items-center justify-between gap-3 rounded-lg bg-surface-3 px-2.5 py-1.5 text-xs"
          >
            <span className="truncate-middle numeric min-w-0">{c.relay}</span>
            <span className={cn("flex shrink-0 items-center gap-1.5", style.className)}>
              <Icon className={cn("size-3.5", style.spin && "animate-spin")} aria-hidden />
              {c.state === "failed" && c.reason ? `${style.label}: ${c.reason}` : style.label}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const RELAY_ROW: Record<
  RelayCheck["state"],
  { icon: typeof Check; label: string; className: string; spin: boolean }
> = {
  checking: {
    icon: Loader2,
    label: "Consultando…",
    className: "text-muted-foreground",
    spin: true,
  },
  found: { icon: Check, label: "Lo tiene", className: "text-success", spin: false },
  republished: {
    icon: Check,
    label: "Reenviado",
    className: "text-success",
    spin: false,
  },
  missing: { icon: X, label: "No lo tiene", className: "text-warning", spin: false },
  failed: { icon: X, label: "Falló", className: "text-danger", spin: false },
}

function safeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return pubkey
  }
}
