import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import { KINDS } from "@/lib/domain/kinds"
import { base64UrlEncode } from "@/lib/nostr/base64"
import { nowSeconds } from "@/lib/nostr/created-at"
import type { SignerPort } from "@/lib/nostr/types"

/**
 * Mint a NIP-98 `Authorization` header value.
 *
 * One signature per request, which on a NIP-46 signer is a round trip to the
 * bunker — so callers should batch (one list endpoint, not four) rather than
 * signing per row. Mirrors createBlossomUploadAuthorization() in
 * src/lib/blossom/upload.ts; the two schemes differ only in kind and tags.
 *
 * @param url MUST be the absolute URL actually requested, query string
 *   included. The server compares it byte for byte after normalising the
 *   origin, so a relative path or a stripped `?nonce=` produces a 401.
 * @param body The exact string that will be sent. Its sha256 goes in the
 *   `payload` tag, binding the token to this body and nothing else.
 */
export async function createNip98Token(
  signer: SignerPort,
  url: string,
  method: string,
  body?: string
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
    /**
     * Random, and load-bearing.
     *
     * Every other input to this event is deterministic — same URL, same method,
     * same body hash, same key, and `created_at` only has one-second
     * resolution. Two mints of the same coupon inside one second would
     * therefore hash to the SAME event id, and the server's replay cache would
     * reject the second one as a replay. It is not wrong to do that; the two
     * requests are genuinely indistinguishable without this.
     *
     * A cashier issuing coupons to a queue does exactly that, so the nonce is
     * what makes the second one a different request.
     */
    ["nonce", randomNonce()],
  ]
  if (body) tags.push(["payload", bytesToHex(sha256(utf8ToBytes(body)))])

  const signed = await signer.signEvent({
    kind: KINDS.HTTP_AUTH,
    // One second back, like the blossom token: a server whose clock trails ours
    // by a hair would otherwise see a token from its own future and reject it.
    created_at: nowSeconds() - 1,
    content: "",
    tags,
  })

  return `Nostr ${base64UrlEncode(JSON.stringify(signed))}`
}

function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
}
