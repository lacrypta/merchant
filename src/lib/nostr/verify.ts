import { verifyEvent } from "nostr-tools/pure"

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
