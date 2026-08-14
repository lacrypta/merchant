/**
 * Replay already-signed catalog events onto write relays that are missing them.
 *
 * Relays drop events and a newly added write relay has none of the history.
 * Re-signing would burn a NIP-46 tap per product and bump `created_at`, so
 * this module only ever plans a verbatim rebroadcast: same bytes, same id.
 */

import { COUPON_DISCOVERY_D } from "@/lib/domain/coupon-discovery"
import { KINDS } from "@/lib/domain/kinds"
import { WOO_CONFIG_D } from "@/lib/domain/woo-config"
import { WOO_SYNC_D } from "@/lib/domain/woo-sync-state"
import { coordinateOf, tagValue } from "@/lib/nostr/tags"
import type { Filter, SignedEvent } from "@/lib/nostr/types"

/** Quiet gap between events. Two per second is already hot for public relays. */
export const BASE_PACE_MS = 500
/** First backoff once a relay says we are going too fast. */
export const RATE_LIMIT_PACE_MS = 3_000
export const MAX_PACE_MS = 15_000

const CATALOG_DELETE_KINDS = new Set<number>([
  KINDS.PRODUCT,
  KINDS.PRODUCT_DRAFT,
  KINDS.CATEGORY,
])

export interface ReplayItem {
  event: SignedEvent
  relays: string[]
}

/** Filters that define "the catalog" for a presence check. Same shape as the dashboard read. */
export function catalogSyncFilters(pubkey: string): Filter[] {
  return [
    {
      // 30403 is still read even though nothing writes drafts any more: the
      // sweep is the only thing that can find a leftover from before the
      // feature was removed, and without this kind it never sees one.
      kinds: [KINDS.PRODUCT, KINDS.PRODUCT_DRAFT, KINDS.CATEGORY],
      authors: [pubkey],
    },
    { kinds: [KINDS.DELETION], authors: [pubkey] },
    { kinds: [KINDS.RELAY_LIST], authors: [pubkey] },
    {
      kinds: [KINDS.APP_DATA],
      authors: [pubkey],
      // Scoped to OUR `d` tags: kind 30078 is shared by every app that stores
      // per-user data, and pulling all of them would drag down unrelated blobs.
      "#d": [WOO_CONFIG_D, WOO_SYNC_D, COUPON_DISCOVERY_D],
    },
  ]
}

/** NIP-01: newest wins; on an equal created_at the LOWEST event id wins. */
function latestByAddress(events: SignedEvent[]): SignedEvent[] {
  const best = new Map<string, SignedEvent>()
  for (const e of events) {
    const key = coordinateOf(e)
    if (!key) continue
    const cur = best.get(key)
    if (
      !cur ||
      e.created_at > cur.created_at ||
      (e.created_at === cur.created_at && e.id < cur.id)
    ) {
      best.set(key, e)
    }
  }
  return [...best.values()]
}

/**
 * The signed events that MUST exist on every write relay.
 *
 * Live products, categories, our NIP-78 blobs, the NIP-65 list, deletion
 * tombstones, and the kind-5s that hide deleted catalog coordinates. Leftover
 * live 30403 drafts are left out — spreading those would undo the sweep.
 */
export function collectCanonicalEvents(events: SignedEvent[]): SignedEvent[] {
  const deletionByCoord = new Map<string, SignedEvent>()
  for (const e of events) {
    if (e.kind !== KINDS.DELETION) continue
    for (const t of e.tags) {
      if (t[0] !== "a" || !t[1]) continue
      const [kindStr, author] = t[1].split(":")
      if (author !== e.pubkey) continue
      if (!CATALOG_DELETE_KINDS.has(Number(kindStr))) continue
      const prev = deletionByCoord.get(t[1])
      if (!prev || e.created_at > prev.created_at) deletionByCoord.set(t[1], e)
    }
  }

  const live = events.filter((e) => {
    const coord = coordinateOf(e)
    return !coord || (deletionByCoord.get(coord)?.created_at ?? -1) < e.created_at
  })

  const out: SignedEvent[] = []
  const seen = new Set<string>()
  const push = (e: SignedEvent) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }

  for (const e of latestByAddress(live.filter((x) => x.kind >= 30000))) {
    if (
      e.kind === KINDS.PRODUCT ||
      e.kind === KINDS.CATEGORY ||
      e.kind === KINDS.APP_DATA
    ) {
      push(e)
    } else if (
      e.kind === KINDS.PRODUCT_DRAFT &&
      e.tags.some((t) => t[0] === "deleted")
    ) {
      push(e)
    }
  }

  const relayList = live
    .filter((e) => e.kind === KINDS.RELAY_LIST)
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
  if (relayList) push(relayList)

  for (const e of deletionByCoord.values()) push(e)

  return out
}

/**
 * Replace the previous version of this event in a canonical set.
 *
 * Addressable events replace by coordinate; kind 5 by its `a` tags; the
 * NIP-65 list is a singleton. Used so a save that just landed is in the set
 * a subsequent sync will replay, without waiting for the catalog refetch.
 */
export function upsertCanonical(
  prev: readonly SignedEvent[],
  event: SignedEvent
): SignedEvent[] {
  const coord = coordinateOf(event)
  if (coord) {
    return [...prev.filter((e) => coordinateOf(e) !== coord), event]
  }
  if (event.kind === KINDS.DELETION) {
    const aTags = new Set(
      event.tags.filter((t) => t[0] === "a" && t[1]).map((t) => t[1]!)
    )
    return [
      ...prev.filter((e) => {
        if (e.kind !== KINDS.DELETION) return true
        return !e.tags.some((t) => t[0] === "a" && t[1] && aTags.has(t[1]))
      }),
      event,
    ]
  }
  if (event.kind === KINDS.RELAY_LIST) {
    return [...prev.filter((e) => e.kind !== KINDS.RELAY_LIST), event]
  }
  return [...prev.filter((e) => e.id !== event.id), event]
}

/**
 * Which (event, relays) pairs still need a publish.
 *
 * Every key of `holdingsByRelay` is a target. An absent or empty list means
 * the relay has none of our events — unreachable is treated the same as
 * empty, because a POS asking that relay would also come back with nothing.
 */
export function planReplay(
  canonical: readonly SignedEvent[],
  holdingsByRelay: ReadonlyMap<string, readonly SignedEvent[]>
): ReplayItem[] {
  const relays = [...holdingsByRelay.keys()]
  if (relays.length === 0 || canonical.length === 0) return []

  const idsByRelay = new Map<string, Set<string>>()
  for (const [relay, held] of holdingsByRelay) {
    idsByRelay.set(relay, new Set(held.map((e) => e.id)))
  }

  const items: ReplayItem[] = []
  for (const event of canonical) {
    const missing = relays.filter((r) => !idsByRelay.get(r)?.has(event.id))
    if (missing.length > 0) items.push({ event, relays: missing })
  }
  return items
}

/**
 * Did this ACK mean "slow down", not "I will never take this"?
 *
 * `blocked: kind 30402 is not allowed` is a policy reject and must NOT back
 * off — backing off would stall the rest of the catalog on a relay that will
 * never accept the event. Rate-limit wording is the only match.
 */
export function isRelayRateLimit(reason: string): boolean {
  return /rate.?limit|slow.?down|too many|throttl|banned/i.test(reason)
}

/** Next gap after this event. Unknown rejects leave the base pace alone. */
export function nextPaceMs(prev: number, hitRateLimit: boolean): number {
  if (!hitRateLimit) return BASE_PACE_MS
  if (prev < RATE_LIMIT_PACE_MS) return RATE_LIMIT_PACE_MS
  return Math.min(prev * 2, MAX_PACE_MS)
}

/** Human label for the publish monitor, one line, Spanish like the rest of the queue. */
export function replayLabel(event: SignedEvent): string {
  switch (event.kind) {
    case KINDS.PRODUCT:
      return tagValue(event, "title") || "Producto"
    case KINDS.CATEGORY:
      return tagValue(event, "title") || "Categoría"
    case KINDS.PRODUCT_DRAFT:
      return `Lápida de ${tagValue(event, "title") || "producto"}`
    case KINDS.RELAY_LIST:
      return "Lista de relays (NIP-65)"
    case KINDS.DELETION:
      return event.content.trim() || "Borrado"
    case KINDS.APP_DATA: {
      const d = tagValue(event, "d")
      if (d === COUPON_DISCOVERY_D) return "Anuncio de cupones"
      if (d === WOO_CONFIG_D) return "WooCommerce"
      if (d === WOO_SYNC_D) return "Estado de Woo"
      return "Datos de la app"
    }
    default:
      return `kind ${event.kind}`
  }
}
