import { getEventHash, verifyEvent } from "nostr-tools/pure"

import type { SignedEvent } from "@/lib/nostr/types"

/**
 * Verify a signature without trusting nostr-tools' memo.
 *
 * `finalizeEvent` stamps the event with a non-enumerable-looking but
 * SPREADABLE `verifiedSymbol`, and `verifyEvent` short-circuits on it. Any
 * code that does `{...event, tags: [...]}` therefore carries a stale "already
 * verified" flag onto a mutated object, and the check silently passes.
 *
 * Events arriving from a relay are JSON-parsed and cannot carry a symbol, so
 * this is belt-and-braces for them — but the callers here include payment
 * receipt matching and NIP-98 request authentication, where the failure mode is
 * "we accept a forgery", which is not a place to rely on a caller's discipline.
 * Rebuilding the seven canonical fields drops the memo and anything else
 * riding along.
 */
export function verifySignedEvent(e: SignedEvent): boolean {
  return verifyEvent({
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  } as never)
}

/**
 * Same check, memoised — carefully, because this is the exact trap described
 * above and the first version of it fell in.
 *
 * Keying on `event.id` alone is UNSOUND: `id` is a plain field, so
 * `{...event, content: "otra cosa"}` keeps the id of the event it was copied
 * from and collects the cached verdict for content nobody signed. That is
 * nostr-tools' bug with a different spelling. A test pins it.
 *
 * So the hash is recomputed on EVERY call and only then is the cache consulted.
 * That costs a sha256 over the canonical serialization — microseconds — against
 * the ~1.5 ms of secp256k1 that the cache is actually there to skip. Once the
 * hash matches, `id` provably commits to pubkey, created_at, kind, tags and
 * content, and `sig` is the only field left outside it, so `id:sig` commits to
 * the whole event. The key is the content because we just checked that it is.
 *
 * Exists because the orders screen verifies two events per order inside a
 * `useMemo`: a merchant with a thousand receipts would otherwise pay seconds of
 * blocked main thread on every recompute.
 */
const SWEEP_THRESHOLD = 5_000
const verified = new Map<string, boolean>()

export function verifySignedEventCached(e: SignedEvent): boolean {
  const canonical = {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  }
  if (getEventHash(canonical as never) !== e.id) return false

  const key = `${e.id}:${e.sig}`
  const hit = verified.get(key)
  if (hit !== undefined) return hit

  // Wholesale, not LRU: entries carry no expiry, the map is a speed-up rather
  // than a decision, and 5000 signatures is a rounding error to recompute.
  if (verified.size >= SWEEP_THRESHOLD) verified.clear()

  const result = verifyEvent(canonical as never)
  verified.set(key, result)
  return result
}
