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
  /** Hard ceiling. Reached only when nothing answers at all. */
  timeoutMs?: number
  /**
   * Grace period after the FIRST relay finishes, for slower ones to catch up.
   *
   * This is the knob that decides "fast" versus "complete". 600ms is enough
   * for a second continent on a normal connection and is invisible next to
   * the multi-second wait it replaces.
   */
  settleMs?: number
  /** Human name for this read, shown in the relay log. */
  label?: string
  /**
   * Indices of filters that must hear from EVERY reachable relay before the
   * early cut-off is allowed.
   *
   * Coverage is not completeness. A relay can EOSE a `kind:5` query having
   * simply never stored that deletion, which satisfies "this filter was
   * answered" while the relay that actually holds it is still connecting. Cut
   * there and the deletion is lost — and a lost deletion RESURRECTS content:
   * a product the merchant deleted reappeared on the public storefront about
   * one render in ten.
   *
   * Missing a product is a smaller sin than showing a deleted one, so
   * deletions get to be slow.
   */
  completeFilters?: number[]
  /**
   * How long a `completeFilters` entry may hold the read open.
   *
   * Waiting for literally every relay means waiting for the dead ones, which
   * costs the entire speed win (5.2s vs 0.4s). This is the compromise: give
   * the slow-but-alive relays a real chance, then proceed. Measured on the
   * relays that actually carry deletions — nos.lol answers in ~1.3s and
   * primal in ~1.0s — so 2s clears them with room, and the ceiling is only
   * ever paid by a merchant who has deleted something.
   */
  completeDeadlineMs?: number
}

/** What one relay actually did for one read. */
export interface RelayStat {
  /** Which read this was — "Catálogo", "Perfil", … */
  label: string
  relay: string
  /** Events this relay returned, before cross-relay de-duplication. */
  events: number
  /** Bytes of JSON it sent — a fair proxy for "how much did it carry". */
  bytes: number
  /** Milliseconds from subscribing to its EOSE, or to the cut-off. */
  ms: number
  /**
   * ok      — sent events
   * empty   — answered, had nothing (normal: not every relay stores everything)
   * cut     — still going when we stopped waiting after quorum
   * timeout — never answered at all within the hard ceiling
   */
  status: "ok" | "empty" | "cut" | "timeout"
}

export interface QueryResult {
  events: SignedEvent[]
  /**
   * True only when EVERY query failed outright. Distinct from "answered, but
   * empty" — conflating the two would show a scary relay warning to a
   * merchant who simply has no products yet.
   */
  unreachable: boolean
  /** Per-relay accounting, for the relay log in the navbar. */
  stats: RelayStat[]
}

/**
 * Run each filter against every relay and merge the results, de-duplicated
 * by event id.
 *
 * DO NOT go back to `pool.querySync()`. It resolves only when EVERY relay has
 * sent EOSE, and a relay that never connects is resolved by an internal
 * connection timeout — `maxWaitForConnection`, or `maxWait - 1s` when that is
 * larger. With `relay.lacrypta.ar` down (Cloudflare 1033) that made every
 * single storefront render wait ~5 seconds for a host that was never going to
 * answer, while the actual events had arrived in a couple of hundred
 * milliseconds. Measured: 5031ms to collect 72 events that were all present
 * almost immediately.
 *
 * So: subscribe per relay, and stop as soon as the answers stop arriving
 * rather than as soon as the slowest participant gives up.
 *
 * Always resolves — a dead relay must degrade to fewer results, never to a
 * thrown request.
 */
export async function queryRelays(
  relays: string[],
  filters: Filter[],
  {
    timeoutMs = 6_000,
    settleMs = 600,
    label = "Consulta",
    completeFilters = [],
    completeDeadlineMs = 1_800,
  }: QueryOptions = {}
): Promise<QueryResult> {
  if (relays.length === 0 || filters.length === 0) {
    return { events: [], unreachable: relays.length === 0, stats: [] }
  }

  const startedAt = Date.now()
  /** Accumulated per relay, across all filters. */
  const perRelay = new Map<string, { events: number; bytes: number; ms: number; eosed: number }>(
    relays.map((r) => [r, { events: 0, bytes: 0, ms: 0, eosed: 0 }])
  )

  const byId = new Map<string, SignedEvent>()
  const expected = relays.length * filters.length
  /**
   * Subscriptions that genuinely finished, versus ones that died.
   *
   * These MUST be counted separately. Sharing one counter meant a relay that
   * failed to connect pushed us toward "enough have answered" and cut off the
   * healthy relays still streaming — a merchant with 23 products rendered an
   * empty shop because two dead hosts and one empty-but-fast host reached the
   * threshold before the three relays that actually had the catalog.
   *
   * Quorum is therefore half of the REACHABLE set, recomputed as failures
   * come in, and only real EOSEs count toward it.
   */
  let answered = false

  /**
   * Everything below counts (filter, relay) PAIRS, never callback
   * invocations.
   *
   * nostr-tools fires `onclose` after `oneose` for the same subscription, so
   * any counter incremented by both is double-counting: a check like
   * `eosed + closed >= expected` was satisfied by half the subscriptions, and
   * the read finished while the only two relays holding a deletion were still
   * connecting. That put a deleted product back on the storefront.
   */
  const totalAccounted = () =>
    accountedPerFilter.reduce((n, set) => n + set.size, 0)
  const totalAnswered = () =>
    answeredPerFilter.reduce((n: number, x: number) => n + x, 0)

  /**
   * Per-FILTER progress, not just per-subscription.
   *
   * Quorum over the flat total is not enough: filters are separate
   * subscriptions, so a fast filter finishing everywhere could satisfy the
   * count while a slow one had not been answered by anybody — and that filter
   * silently contributed nothing. When the dropped filter is `kind:5`, every
   * DELETED event comes back to life: a deleted category reappeared on a live
   * storefront and duplicated a whole section.
   *
   * So: no settling until every filter has been answered at least once.
   */
  const answeredPerFilter = new Array<number>(filters.length).fill(0)
  /**
   * Which (filter, relay) pairs are finished, by any means.
   *
   * A SET, not a counter: nostr-tools fires `onclose` after `oneose` for the
   * same subscription, so incrementing two counters let one relay satisfy
   * "answered" and "accounted for" at once — and a critical filter that needs
   * every relay was satisfied by half of them. That put a deleted product
   * back on the storefront roughly one render in ten, always on the fastest
   * ones, because speed is exactly when the cut-off lands early.
   */
  const accountedPerFilter = Array.from(
    { length: filters.length },
    () => new Set<string>()
  )
  const mustBeComplete = new Set(completeFilters)
  const everyFilterCovered = () =>
    answeredPerFilter.every((n, i) => {
      if (!mustBeComplete.has(i)) {
        return n > 0 || accountedPerFilter[i]!.size >= relays.length
      }
      // Every relay accounted for — or we have given them long enough.
      return (
        accountedPerFilter[i]!.size >= relays.length ||
        Date.now() - startedAt >= completeDeadlineMs
      )
    })

  const reachedQuorum = () => {
    if (!everyFilterCovered()) return false
    const dead = totalAccounted() - totalAnswered()
    return totalAnswered() >= Math.max(1, Math.ceil((expected - dead) / 2))
  }

  return new Promise<QueryResult>((resolve) => {
    let done = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const closers: { close: (reason: string) => void }[] = []

    const finish = () => {
      if (done) return
      done = true
      if (settle) clearTimeout(settle)
      clearTimeout(hard)
      clearTimeout(deadlineTimer)
      for (const c of closers) {
        try {
          c.close("done")
        } catch {
          /* already closed */
        }
      }
      const stats: RelayStat[] = relays.map((relay) => {
        const r = perRelay.get(relay)!
        return {
          label,
          relay,
          events: r.events,
          bytes: r.bytes,
          ms: r.ms || Date.now() - startedAt,
          // A relay we stopped waiting for did NOT fail — reporting it as a
          // failure would slander a working relay for our own impatience.
          // "cut" is the honest word for it.
          status:
            r.eosed > 0
              ? r.events > 0
                ? "ok"
                : "empty"
              : r.events > 0
                ? "cut"
                : hitCeiling
                  ? "timeout"
                  : "cut",
        }
      })
      resolve({ events: [...byId.values()], unreachable: !answered, stats })
    }

    // Nothing else fires once the last event has landed, so the deadline
    // needs its own nudge or a critical filter would hold the read to the
    // hard ceiling.
    const deadlineTimer = setTimeout(() => {
      // Finish outright rather than starting another grace period: the
      // deadline IS the grace period, and stacking a second one just adds
      // latency to every page that has ever had a deletion.
      if (!done && reachedQuorum()) finish()
    }, completeDeadlineMs)

    let hitCeiling = false
    const hard = setTimeout(() => {
      hitCeiling = true
      finish()
    }, timeoutMs)

    for (const url of relays) {
      for (const [fi, f] of filters.entries()) {
        try {
          closers.push(
            getPool().subscribe([url], f as NostrToolsFilter, {
              maxWait: timeoutMs,
              onevent: (e) => {
                answered = true
                const r = perRelay.get(url)
                if (r) {
                  r.events += 1
                  r.bytes += JSON.stringify(e).length
                }
                const fresh = !byId.has(e.id)
                byId.set(e.id, e as SignedEvent)
                // Events still arriving means the read is not done. Push the
                // grace period back so a relay mid-stream is never truncated.
                if (fresh && settle) {
                  clearTimeout(settle)
                  settle = setTimeout(finish, settleMs)
                }
              },
              oneose: () => {
                answered = true
                const r = perRelay.get(url)
                if (r) {
                  r.eosed += 1
                  r.ms = Date.now() - startedAt
                }
                answeredPerFilter[fi] += 1
                accountedPerFilter[fi]!.add(url)
                // Everyone reachable has spoken — no reason to wait further.
                if (totalAccounted() >= expected) return finish()
                // Past quorum, give the stragglers a grace period. This is the
                // whole optimisation: the page renders when the relays that
                // have the data have answered, instead of when the slowest
                // participant finally times out.
                if (reachedQuorum() && !settle) {
                  settle = setTimeout(finish, settleMs)
                }
              },
              onclose: () => {
                // A death shrinks the denominator; it never counts as an answer.
                accountedPerFilter[fi]!.add(url)
                if (totalAccounted() >= expected) finish()
                else if (reachedQuorum() && !settle) {
                  // A death can be what completes coverage of the last filter.
                  settle = setTimeout(finish, settleMs)
                }
              },
            })
          )
        } catch {
          accountedPerFilter[fi]!.add(url)
        }
      }
    }
  })
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
