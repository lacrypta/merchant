/**
 * The ONLY place in this codebase that produces a `created_at`.
 * An eslint no-restricted-syntax rule bans inline `Math.floor(Date.now()/1000)`
 * everywhere else.
 *
 * Why this exists: NIP-01 breaks replaceable-event ties on equal `created_at`
 * by lowest event id — and the spec explicitly calls that a convention that
 * "relay implementations may differ" on. So a same-second re-publish has
 * roughly even odds of being permanently shadowed by the very version it was
 * meant to replace, with no error surfaced. Strictly advancing the timestamp
 * is the entire mitigation.
 */

/** Relays reject events too far in the future (khatru ships a 60s policy). */
export const MAX_FORWARD_DRIFT_SECONDS = 60

/** Per-address high-water mark: `${kind}:${pubkey}:${d}` -> last created_at. */
const lastSavedAt = new Map<string, number>()

export class ClockDriftError extends Error {
  constructor(readonly address: string, readonly driftSeconds: number) {
    super(
      `Refusing to publish ${address}: created_at would be ${driftSeconds}s ` +
        `ahead of wall clock (max ${MAX_FORWARD_DRIFT_SECONDS}s). ` +
        `Debounce the save instead — relays reject future-dated events.`
    )
    this.name = "ClockDriftError"
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Monotonic `created_at` for one addressable coordinate.
 *
 * Scoped per address, not globally: replacement scope is per-address, so a
 * global counter would drift every coordinate forward whenever any one of
 * them is saved.
 *
 * @throws ClockDriftError when saves are so rapid the timestamp would run
 *   more than MAX_FORWARD_DRIFT_SECONDS ahead. Callers should debounce.
 */
export function nextCreatedAt(address: string, previous?: number): number {
  const now = nowSeconds()
  const floor = Math.max(previous ?? 0, lastSavedAt.get(address) ?? 0)
  const ts = Math.max(now, floor + 1)

  const drift = ts - now
  if (drift > MAX_FORWARD_DRIFT_SECONDS) {
    throw new ClockDriftError(address, drift)
  }

  lastSavedAt.set(address, ts)
  return ts
}

/** Test seam. Never call from application code. */
export function __resetCreatedAtState(): void {
  lastSavedAt.clear()
}
