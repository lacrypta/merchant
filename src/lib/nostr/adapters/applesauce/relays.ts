"use client"

import { EMPTY, firstValueFrom, lastValueFrom, toArray, timeout, catchError, of } from "rxjs"

import { ensureNostrGlobals } from "@/lib/nostr/adapters/applesauce"
import { addRelayLog } from "@/lib/nostr/relay-log"
import { enabledRelays } from "@/lib/nostr/relay-prefs"
import type {
  Filter,
  PublishReport,
  SignedEvent,
  Unsubscribe,
} from "@/lib/nostr/types"

/**
 * Browser-side relay I/O.
 *
 * Two applesauce-relay facts that shape this file:
 *  - `publish()` resolves to PublishResponse[] = {ok, from, message?}. Per-relay
 *    results are first-class, which is exactly what the partial-failure UI
 *    needs — publishing is NEVER a boolean here.
 *  - `subscription()` and `req()` do NOT emit a virtual EOSE (removed in v6).
 *    `request()` is the one that COMPLETES when relays are done, so it is what
 *    a one-shot load should use.
 */

export async function publishEvent(
  event: SignedEvent,
  relays: string[],
  opts: { timeoutMs?: number } = {}
): Promise<PublishReport> {
  const pool = ensureNostrGlobals()

  if (relays.length === 0) {
    return {
      event,
      ok: [],
      failed: [{ relay: "(ninguno)", reason: "No hay relays de escritura configurados" }],
    }
  }

  let responses
  try {
    responses = await pool.publish(relays, event, {
      timeout: opts.timeoutMs ?? 10_000,
    })
  } catch (e) {
    return {
      event,
      ok: [],
      failed: relays.map((r) => ({
        relay: r,
        reason: e instanceof Error ? e.message : "error desconocido",
      })),
    }
  }

  return {
    event,
    ok: responses.filter((r) => r.ok).map((r) => r.from),
    failed: responses
      .filter((r) => !r.ok)
      .map((r) => ({ relay: r.from, reason: r.message || "rechazado sin motivo" })),
  }
}

export interface RelayProgress {
  relay: string
  state: "pending" | "ok" | "failed"
  reason?: string
}

/**
 * Publish with LIVE per-relay progress.
 *
 * Uses `pool.event()` rather than `pool.publish()` because it emits each
 * relay's PublishResponse as it arrives, which is what drives the progress
 * ring. Tradeoff, stated plainly: `event()` calls the relay directly and so
 * applies NO retries — `publish()` is the one with the default 3 retries.
 * For an interactive save that's the right trade (the merchant sees exactly
 * what happened and can retry deliberately), but don't use this for the
 * background outbox.
 */
export function publishEventStreaming(
  event: SignedEvent,
  relays: string[],
  onProgress: (progress: RelayProgress[]) => void,
  opts: { timeoutMs?: number } = {}
): Promise<PublishReport> {
  const pool = ensureNostrGlobals()

  if (relays.length === 0) {
    const report: PublishReport = {
      event,
      ok: [],
      failed: [
        { relay: "(ninguno)", reason: "No hay relays de escritura configurados" },
      ],
    }
    return Promise.resolve(report)
  }

  /**
   * Match responses back to the relay we asked.
   *
   * applesauce normalises URLs internally (it appends a trailing slash), so
   * `res.from` is `wss://relay.damus.io/` while our configured entry is
   * `wss://relay.damus.io`. Keying the map on the raw string made every
   * response create a SECOND row: the real result showed up as an extra
   * relay while the original stayed pending and was then reported as a
   * timeout — inflating the total and inventing failures.
   */
  const keyOf = (url: string) => url.replace(/\/+$/, "").toLowerCase()

  const progress = new Map<string, RelayProgress>(
    relays.map((r) => [keyOf(r), { relay: r, state: "pending" as const }])
  )
  const emit = () => onProgress([...progress.values()])
  emit()

  return new Promise<PublishReport>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sub.unsubscribe()

      const values = [...progress.values()]
      // Anything still pending when we stop waiting is a timeout, not a
      // success — never report an unanswered relay as ok.
      for (const p of values) {
        if (p.state === "pending") {
          p.state = "failed"
          p.reason = "sin respuesta"
        }
      }
      emit()

      resolve({
        event,
        ok: values.filter((p) => p.state === "ok").map((p) => p.relay),
        failed: values
          .filter((p) => p.state !== "ok")
          .map((p) => ({ relay: p.relay, reason: p.reason ?? "desconocido" })),
      })
    }

    const timer = setTimeout(finish, opts.timeoutMs ?? 12_000)

    const sub = pool.event(relays, event).subscribe({
      next: (res) => {
        const key = keyOf(res.from)
        progress.set(key, {
          // Keep the URL the merchant configured, not applesauce's normalised
          // form, so the detail list matches their relay settings verbatim.
          relay: progress.get(key)?.relay ?? res.from,
          state: res.ok ? "ok" : "failed",
          reason: res.ok ? undefined : res.message || "rechazado",
        })
        emit()
        if ([...progress.values()].every((p) => p.state !== "pending")) finish()
      },
      error: () => finish(),
      complete: () => finish(),
    })
  })
}

/**
 * One-shot load. `request()` completes on its own once relays are done and
 * de-duplicates across them, so no manual EOSE bookkeeping is needed.
 */
/**
 * One-shot read across relays, one subscription per relay.
 *
 * Per-relay rather than one combined request for two reasons. First, the
 * timeout: `pool.request()` completes only when EVERY relay is done, so a
 * host that never connects used to hold the whole read open — the dashboard
 * waited eight seconds for `relay.lacrypta.ar` (Cloudflare 1033) while the
 * events had all arrived in a few hundred milliseconds. Second, attribution:
 * the relay panel can only say "this relay gave us 12 events" if the reads
 * were separable in the first place.
 *
 * The timeout is two limits, not one:
 *   first: the ceiling before giving up on any answer at all
 *   each:  the quiet period after the last event that means "that's all"
 *
 * Switching to EMPTY rather than throwing completes the stream, so `toArray`
 * still emits everything collected up to that point.
 */
export async function queryEvents(
  filters: Filter[],
  relays: string[],
  opts: { timeoutMs?: number; settleMs?: number; label?: string } = {}
): Promise<SignedEvent[]> {
  if (relays.length === 0 || filters.length === 0) return []
  const pool = ensureNostrGlobals()
  const label = opts.label ?? "Consulta"
  // One place to honour the relay toggles, so every caller gets it for free.
  const active = enabledRelays(relays)

  const results = await Promise.all(
    active.map(async (url) => {
      const startedAt = Date.now()
      const perRelay: SignedEvent[] = []

      await Promise.all(
        filters.map((f) =>
          lastValueFrom(
            pool.request([url], f as never).pipe(
              timeout({
                first: opts.timeoutMs ?? 8_000,
                each: opts.settleMs ?? 600,
                with: () => EMPTY,
              }),
              toArray(),
              catchError(() => of([] as SignedEvent[]))
            )
          )
            .then((list) => {
              for (const e of list as SignedEvent[]) perRelay.push(e)
            })
            .catch(() => {})
        )
      )

      addRelayLog({
        label,
        relay: url,
        events: perRelay.length,
        bytes: perRelay.reduce((n, e) => n + JSON.stringify(e).length, 0),
        ms: Date.now() - startedAt,
        status: perRelay.length > 0 ? "ok" : "empty",
        origin: "client",
      })

      return perRelay
    })
  )

  // Cross-relay de-duplication. The per-relay counts in the log are
  // deliberately the RAW totals — that is the point of the panel: seeing that
  // four relays each carried the same twelve events is the interesting part.
  const byId = new Map<string, SignedEvent>()
  for (const list of results) {
    for (const e of list) byId.set(e.id, e)
  }
  return [...byId.values()]
}

/** Live subscription. Never completes; call the returned function to stop. */
export function subscribeEvents(
  filters: Filter[],
  relays: string[],
  onEvent: (e: SignedEvent) => void
): Unsubscribe {
  if (relays.length === 0 || filters.length === 0) return () => {}
  const pool = ensureNostrGlobals()
  const active = enabledRelays(relays)

  const subs = filters.map((f) =>
    pool.subscription(active, f as never).subscribe({
      next: (e) => onEvent(e as SignedEvent),
      error: () => {
        /* a dead relay must not tear down the rest */
      },
    })
  )

  return () => subs.forEach((s) => s.unsubscribe())
}

/** Current connection state per relay, for the settings screen. */
export async function relayStatuses(
  relays: string[]
): Promise<Record<string, boolean>> {
  const pool = ensureNostrGlobals()
  for (const url of relays) pool.relay(url)

  const snapshot = await firstValueFrom(
    pool.status$.pipe(
      timeout(3_000),
      catchError(() => of({} as Record<string, { connected: boolean }>))
    )
  )

  const out: Record<string, boolean> = {}
  for (const url of relays) {
    out[url] = Boolean(
      (snapshot as Record<string, { connected?: boolean }>)[url]?.connected
    )
  }
  return out
}
