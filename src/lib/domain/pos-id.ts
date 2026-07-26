import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"

/**
 * Stable integer ids for the LaPOS JSON projection.
 *
 * LaPOS needs `id: number` and `category_id: number`, and we hold uuids. The
 * ids are DERIVED, never stored on the event, so there is nothing to keep in
 * sync — but that carries a real limitation worth stating plainly:
 *
 *   Any purely-derived id whose collision-disambiguation depends on the
 *   current item set will shift when a colliding sibling is added or removed.
 *
 * Double hashing confines that instability to actual collision clusters,
 * because each item's candidate sequence depends only on its own `d`.
 * Collision probability is ~5.8e-5 at 500 products over 2^31. If a collision
 * is ever observed in production, adding an explicit `pos_id` tag is a
 * backward-compatible one-line change to the builder and parser.
 */

/** int32-safe, and never 0 — 0 is reserved for the "Sin categoría" bucket. */
const MAX = 2_147_483_646

function int31(s: string): number {
  const h = sha256(utf8ToBytes(s))
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0
  return (n % MAX) + 1
}

/** Candidate sequence depends ONLY on this item's own `d`. */
export function derivePosId(d: string, probe = 0): number {
  return int31(probe === 0 ? d : `${d}:${probe}`)
}

export interface PosIdAssignment {
  ids: Map<string, number>
  /** d-tags that needed probing. Surfaced in Settings as a warning. */
  conflicts: string[]
}

/**
 * Assign collision-free ids across a set.
 *
 * Iterates in sorted-`d` order so the result is independent of input order —
 * otherwise the same catalog would project different ids depending on the
 * order relays happened to return events in.
 */
export function assignPosIds<T extends { d: string }>(
  items: readonly T[]
): PosIdAssignment {
  const ids = new Map<string, number>()
  const taken = new Set<number>()
  const conflicts: string[] = []

  for (const item of [...items].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))) {
    let probe = 0
    let id = derivePosId(item.d)
    while (taken.has(id)) {
      conflicts.push(item.d)
      id = derivePosId(item.d, ++probe)
    }
    taken.add(id)
    ids.set(item.d, id)
  }

  return { ids, conflicts }
}
