"use client"

import { useQuery } from "@tanstack/react-query"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { usePublishMonitor } from "@/components/publish/publish-monitor"
import {
  buildCouponDiscoveryEvent,
  couponEndpoints,
  isOurCouponDiscovery,
  parseCouponDiscovery,
  type CouponDiscovery,
} from "@/lib/domain/coupon-discovery"
import { useRelayCheck, type RelayCheck } from "@/components/coupons/use-relay-check"
import { writeRelays } from "@/lib/domain/relay-list"
import type { EventTemplate, PublishReport, SignedEvent } from "@/lib/nostr/types"

/**
 * Is this service activated as the merchant's coupon manager?
 *
 * "Activated" means the merchant has signed a kind-30078 naming THIS
 * deployment's mint and claim URLs plus the pubkey that vouches for its
 * coupons. That event is the only way a till which has never talked to us can
 * find us, so until it exists a coupon is a row in a database nobody can reach.
 *
 * WHERE THAT EVENT LIVES is the subtle part, and the reason this hook is not
 * three lines. Relays are not storage we control: they drop events, they go
 * away, and a read can miss one that is genuinely out there — which is exactly
 * what happened before this was written, where a reload showed "Desactivado" to
 * a merchant who had activated minutes earlier. So the signed event is kept in
 * our own database, and that copy is the answer on load. The relays are then
 * checked against it, and if the announcement is not out there we re-broadcast
 * it — no new signature needed, because the bytes are already signed.
 *
 * Two sources, one rule for which wins: the newer `created_at`, the same way a
 * relay picks between two versions of an addressable event.
 */

interface ManagerInfo {
  pubkey: string
  npub: string
}

export type CouponServiceState =
  | { kind: "loading" }
  /** The SERVER is missing COUPON_MANAGER_NSEC or DATABASE_URL. */
  | { kind: "unavailable"; message: string }
  /** Ready to activate, nothing announced yet. */
  | { kind: "inactive"; desired: CouponDiscovery }
  | { kind: "active"; published: CouponDiscovery; event: SignedEvent }
  /** Announced, but pointing at a different host or a rotated manager key. */
  | {
      kind: "outdated"
      published: CouponDiscovery
      desired: CouponDiscovery
      event: SignedEvent
    }
  /** Announced under our `d`, unreadable — another client, or an older version. */
  | { kind: "unreadable"; desired: CouponDiscovery; reason: string }

/** Where the announcement lives. Drawn as chips plus a per-relay list. */
export interface DiscoveryPresence {
  /** True once our own database holds the signed event. */
  savedOnServer: boolean
  /** One row per write relay — the detail panel lists these. */
  relays: RelayCheck[]
  /** The same thing rolled up, for the chip. */
  summary: "checking" | "all" | "partial" | "none" | "republishing"
  /** How many relays confirmed it, and out of how many. */
  found: number
  total: number
}

/** Live progress of a publish, for the card's progress bar. */
export interface ActivationProgress {
  /** 0–100. Real relay ACKs, not a timer. */
  percent: number
  /** es-AR line describing what is happening right now. */
  label: string
  /** True while the total is still unknown — the bar pulses instead. */
  indeterminate: boolean
}

export interface CouponService {
  state: CouponServiceState
  presence: DiscoveryPresence
  /**
   * True only when the announcement points at THIS server with THIS manager
   * key. `outdated` is deliberately not active: the advert a POS would read
   * sends it somewhere else, so coupons created here would be unreachable.
   */
  isActive: boolean
  /** Sign and publish the announcement. No-op when unavailable. */
  activate: () => void
  activating: boolean
  /** Null unless a publish is in flight. */
  progress: ActivationProgress | null
  /** Set when the event published but we could not store it. */
  saveError: string | null
}

const ACTIVATION_LABEL = "Servicio de cupones"
const REBROADCAST_LABEL = "Reenviar anuncio de cupones"

/** Signing is a NIP-46 round trip — worth its own visible slice of the bar. */
const SIGNING_SHARE = 20

export function useCouponService(
  pubkey: string,
  {
    stored,
    saveDiscovery,
  }: {
    /** The signed event our database has, if any. */
    stored: SignedEvent | null
    saveDiscovery: (event: SignedEvent) => Promise<void>
  }
): CouponService {
  const { signer } = useAuth()
  const { appData, relayEntries, refresh } = useCatalog()
  const { jobs, enqueue } = usePublishMonitor()
  const [activating, setActivating] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  /** Event ids we have already re-sent this session, so a miss cannot loop. */
  const rebroadcastRef = React.useRef(new Set<string>())
  const [rebroadcasting, setRebroadcasting] = React.useState<string | null>(null)

  const managerQuery = useQuery({
    queryKey: ["coupon-manager"],
    // A property of the deployment, not of the merchant: it only changes when an
    // operator rotates an env var and restarts.
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async (): Promise<ManagerInfo> => {
      const res = await fetch("/api/coupons/manager", { cache: "no-store" })
      // Parsed defensively: a proxy in front of this app answers 502 with an
      // HTML page, and `res.json()` on that throws a SyntaxError that says
      // "Unexpected token '<'" — which is what the merchant would have read.
      const data = (await res.json().catch(() => null)) as
        | (ManagerInfo & { error?: string })
        | null
      if (!res.ok || !data) {
        throw new Error(data?.error ?? "No pudimos consultar el servidor.")
      }
      return data
    },
  })

  /** The announcement as the relays currently have it. */
  const relayEvent = React.useMemo(
    () => appData.find((e) => isOurCouponDiscovery(e, pubkey)) ?? null,
    [appData, pubkey]
  )

  /**
   * Newest wins, exactly as a relay would decide between two versions.
   *
   * Usually these agree. They disagree when the merchant activated from another
   * device (relay newer) or when relays lost the event (database newer) — and
   * the second case is the one this whole mechanism exists for.
   */
  const current: SignedEvent | null = React.useMemo(() => {
    if (!stored) return relayEvent
    if (!relayEvent) return stored
    return relayEvent.created_at > stored.created_at ? relayEvent : stored
  }, [stored, relayEvent])

  const desired: CouponDiscovery | null = React.useMemo(() => {
    if (!managerQuery.data) return null
    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || window.location.origin
    return {
      v: 1,
      managerPubkey: managerQuery.data.pubkey,
      ...couponEndpoints(origin),
    }
  }, [managerQuery.data])

  const state: CouponServiceState = React.useMemo(() => {
    if (managerQuery.isPending) return { kind: "loading" }
    if (managerQuery.error || !desired) {
      return {
        kind: "unavailable",
        message:
          managerQuery.error instanceof Error
            ? managerQuery.error.message
            : "Este servidor no tiene cupones habilitados.",
      }
    }
    if (!current) return { kind: "inactive", desired }

    const parsed = parseCouponDiscovery(current.content)
    if (!parsed.ok) return { kind: "unreadable", desired, reason: parsed.reason }

    const same =
      parsed.value.managerPubkey === desired.managerPubkey &&
      parsed.value.mintUrl === desired.mintUrl &&
      parsed.value.claimUrl === desired.claimUrl

    return same
      ? { kind: "active", published: parsed.value, event: current }
      : { kind: "outdated", published: parsed.value, desired, event: current }
  }, [managerQuery.isPending, managerQuery.error, desired, current])

  /**
   * Is the announcement actually out on the relays?
   *
   * Judged by event ID, not by "some event with our `d` exists": an older
   * version still sitting on a relay is not the announcement we mean, and a POS
   * reading it would be sent to the wrong endpoints.
   */
  const relayList = React.useMemo(() => writeRelays(relayEntries), [relayEntries])

  /**
   * Ask each write relay, one by one, whether it holds this exact event.
   *
   * The catalog's merged read cannot answer per relay, and per relay is the
   * question: a POS queries the merchant's relays, so one that never got the
   * announcement is a till that finds nothing.
   */
  const check = useRelayCheck(current, relayList)

  const presence: DiscoveryPresence = React.useMemo(() => {
    const total = check.checks.length
    // "republished" counts as found: the relay accepted it just now.
    const found = check.checks.filter(
      (c) => c.state === "found" || c.state === "republished"
    ).length
    const summary: DiscoveryPresence["summary"] = rebroadcasting
      ? "republishing"
      : check.checking
        ? "checking"
        : total === 0
          ? "none"
          : found === total
            ? "all"
            : found > 0
              ? "partial"
              : "none"
    return { savedOnServer: !!stored, relays: check.checks, summary, found, total }
  }, [check.checks, check.checking, rebroadcasting, stored])

  /** Re-send an already-signed event, verbatim. Costs no signature. */
  const rebroadcast = React.useCallback(
    (event: SignedEvent, targets: string[], label: string) => {
      if (targets.length === 0) return
      rebroadcastRef.current.add(event.id)
      setRebroadcasting(event.id)
      const template: EventTemplate = {
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at,
      }
      enqueue({
        label,
        template,
        // Not a re-sign: the queue asks for a signed event and we already have
        // the one the merchant approved. Same bytes, same id, same signature.
        sign: async () => event,
        // Only the relays that are actually missing it. Re-sending to relays
        // that already answered "yes" is noise on their side and tells the
        // merchant nothing new.
        relays: targets,
        onSettled: (report: PublishReport | null) => {
          setRebroadcasting(null)
          // Fold the outcome into the per-relay rows, so each one says whether
          // it took the event this time.
          check.applyReport(report)
          if (report && report.ok.length > 0) refresh()
        },
      })
    },
    [enqueue, refresh, check]
  )

  /**
   * Put the announcement back on the relays when it is missing.
   *
   * Guarded three ways so this can never become a loop: only after the catalog
   * read has settled, only once per event id per session, and only for an event
   * that is genuinely current.
   */
  React.useEffect(() => {
    if (!current || check.checking || check.missing.length === 0) return
    if (state.kind !== "active" && state.kind !== "outdated") return
    if (rebroadcastRef.current.has(current.id)) return

    // Deferred: a synchronous setState in an effect body cascades a render, and
    // `rebroadcast` sets one. Same idiom as CatalogProvider's adoption effect.
    const event = current
    const targets = check.missing
    const timer = setTimeout(() => rebroadcast(event, targets, REBROADCAST_LABEL), 0)
    return () => clearTimeout(timer)
  }, [current, check.checking, check.missing, state.kind, rebroadcast])

  /**
   * Catch our database up when the relays hold something newer.
   *
   * The mirror of the case above: the merchant activated from another device,
   * so the durable copy here is out of date.
   */
  const syncedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!relayEvent || !current || relayEvent.id !== current.id) return
    if (stored?.id === relayEvent.id) return
    if (syncedRef.current === relayEvent.id) return
    syncedRef.current = relayEvent.id
    void saveDiscovery(relayEvent).catch(() => {
      /* The card still works off the relay copy; nothing to tell the merchant. */
    })
  }, [relayEvent, current, stored, saveDiscovery])

  const job = React.useMemo(() => {
    const ours = jobs.filter(
      (j) => j.label === ACTIVATION_LABEL || j.label === REBROADCAST_LABEL
    )
    return ours.length > 0 ? ours[ours.length - 1]! : null
  }, [jobs])

  const busy = activating || !!rebroadcasting

  const progress = React.useMemo<ActivationProgress | null>(() => {
    if (!busy) return null
    const resending = !!rebroadcasting

    if (!job || job.phase === "queued") {
      return { percent: 0, label: "En cola…", indeterminate: true }
    }
    if (job.phase === "signing") {
      return {
        percent: SIGNING_SHARE / 2,
        label: resending ? "Preparando el reenvío…" : "Firmando con tu clave…",
        indeterminate: true,
      }
    }
    if (job.phase === "publishing") {
      const total = job.progress.length
      const answered = job.progress.filter((r) => r.state !== "pending").length
      const verb = resending ? "Reenviando" : "Publicando"
      if (total === 0) {
        return { percent: SIGNING_SHARE, label: `${verb}…`, indeterminate: true }
      }
      return {
        percent: SIGNING_SHARE + ((100 - SIGNING_SHARE) * answered) / total,
        label: `${verb} en ${answered}/${total} relays…`,
        indeterminate: false,
      }
    }

    const okCount = job.progress.filter((r) => r.state === "ok").length
    return {
      percent: 100,
      label:
        okCount > 0 ? `Publicado en ${okCount} relays` : "No entró en ningún relay",
      indeterminate: false,
    }
  }, [busy, job, rebroadcasting])

  /** Hold the finished bar briefly so the outcome is legible, not a flash. */
  React.useEffect(() => {
    if (!activating || !job) return
    if (job.phase !== "done" && job.phase !== "failed") return
    const timer = window.setTimeout(() => setActivating(false), 900)
    return () => window.clearTimeout(timer)
  }, [activating, job])

  const activate = React.useCallback(() => {
    if (!signer || !pubkey) return
    if (state.kind === "loading" || state.kind === "unavailable") return
    if (state.kind === "active") return

    setActivating(true)
    setSaveError(null)

    const template = buildCouponDiscoveryEvent(state.desired, pubkey, current?.created_at)

    enqueue({
      label: ACTIVATION_LABEL,
      template,
      sign: async (t) => {
        const signed = (await signer.signEvent(t)) as SignedEvent
        // Never auto-resend what we are deliberately publishing right now: the
        // relay read will not show it for a while, and without this the effect
        // below would fire a redundant re-broadcast seconds later.
        rebroadcastRef.current.add(signed.id)
        // Store it the moment it exists, before the relays have answered. The
        // database copy is what survives a reload and what a re-broadcast
        // replays — losing it because a relay timed out would be the whole bug
        // this mechanism was written to fix.
        try {
          await saveDiscovery(signed)
        } catch (e) {
          setSaveError(
            e instanceof Error
              ? e.message
              : "Publicamos el anuncio pero no pudimos guardarlo."
          )
        }
        return signed
      },
      relays: relayList,
    })
  }, [signer, pubkey, state, current, enqueue, relayList, saveDiscovery])

  return {
    state,
    presence,
    isActive: state.kind === "active",
    activate,
    activating: busy,
    progress,
    saveError,
  }
}
