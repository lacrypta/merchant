import "server-only"

import { SimplePool } from "nostr-tools/pool"
import type { Filter as NostrToolsFilter } from "nostr-tools"

import type { Filter, SignedEvent } from "@/lib/nostr/types"

/**
 * Server-side relay reads for the public storefront and the POS projection.
 *
 * Deliberately OUTSIDE the signer port: no signer, a different lifetime, and
 * Node-only. Node 22 ships a stable global `WebSocket`, so nostr-tools needs
 * no `ws` polyfill here (this is why .nvmrc pins 22 — on Node 20 the global
 * is behind a flag and SimplePool would throw).
 *
 * NOTE ON THE API: nostr-tools' pool methods take a SINGLE `Filter`, not an
 * array — `subscribeMany(relays, filter, params)`. Passing an array serialises
 * to `["REQ", id, [{...}]]` and every relay rejects it with
 * "provided filter is not an object". We therefore fan out one query per
 * filter and merge, rather than casting the type away.
 */

let pool: SimplePool | undefined

function getPool(): SimplePool {
  pool ??= new SimplePool()
  return pool
}

export interface QueryOptions {
  timeoutMs?: number
}

export interface QueryResult {
  events: SignedEvent[]
  /**
   * True only when EVERY query failed outright. Distinct from "answered, but
   * empty" — conflating the two would show a scary relay warning to a
   * merchant who simply has no products yet.
   */
  unreachable: boolean
}

/**
 * Run each filter against every relay and merge the results, de-duplicated
 * by event id.
 *
 * Always resolves — a dead relay (e.g. relay.lacrypta.ar's current Cloudflare
 * 1033) must degrade to fewer results, never to a thrown request.
 */
export async function queryRelays(
  relays: string[],
  filters: Filter[],
  { timeoutMs = 6_000 }: QueryOptions = {}
): Promise<QueryResult> {
  if (relays.length === 0 || filters.length === 0) {
    return { events: [], unreachable: relays.length === 0 }
  }

  const results = await Promise.allSettled(
    filters.map((f) =>
      getPool().querySync(relays, f as NostrToolsFilter, { maxWait: timeoutMs })
    )
  )

  const byId = new Map<string, SignedEvent>()
  let anySucceeded = false

  for (const r of results) {
    if (r.status !== "fulfilled") continue
    anySucceeded = true
    for (const e of r.value) byId.set(e.id, e as SignedEvent)
  }

  return { events: [...byId.values()], unreachable: !anySucceeded }
}

/**
 * Newest-wins de-duplication for addressable events.
 *
 * NIP-01 breaks equal-`created_at` ties by LOWEST event id. The spec calls
 * this a convention relays "may differ" on, so we apply it ourselves rather
 * than trusting whatever order relays returned.
 */
export function latestByAddress(events: SignedEvent[]): SignedEvent[] {
  const best = new Map<string, SignedEvent>()

  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1] ?? ""
    const key = `${e.kind}:${e.pubkey}:${d}`
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
