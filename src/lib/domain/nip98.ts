import { KINDS } from "@/lib/domain/kinds"
import { tagValue } from "@/lib/nostr/tags"
import type { SignedEvent } from "@/lib/nostr/types"
import { verifySignedEvent } from "@/lib/nostr/verify"

/**
 * NIP-98: proving who is making an HTTP request with a nostr signature.
 *
 * The client signs a kind-27235 naming the exact URL and method it is about to
 * call, base64s it into an `Authorization: Nostr …` header, and throws the key
 * material away. There is no session, no cookie and nothing for us to store —
 * which is the only reason a stateless service can be multi-tenant over
 * arbitrary npubs at all.
 *
 * Everything here is pure. The Request-facing half (reading the body, working
 * out our own external URL, remembering event ids) is src/lib/server/nip98.ts.
 */

/**
 * How far a client's clock may be off.
 *
 * Symmetric, because both directions happen: a phone that is a minute slow
 * signs a token we would otherwise call stale, and one that is a minute fast
 * signs one from the future. NIP-98 suggests 60 seconds and every
 * implementation in the wild uses it, so a wider window would only be us being
 * unusually generous with the replay surface.
 */
export const NIP98_MAX_AGE_SECONDS = 60

export type Nip98Failure =
  | "malformed"
  | "wrong-kind"
  | "bad-signature"
  | "stale"
  | "method-mismatch"
  | "url-mismatch"
  | "payload-mismatch"

export interface Nip98Expectation {
  /** OUR externally-visible URL for this request, including any query string. */
  url: string
  method: string
  /** Lowercase hex sha256 of the raw body. Undefined when there is no body. */
  payloadSha256?: string
  /** Unix seconds, from the server's clock. */
  now: number
}

export type Nip98Verdict =
  | { ok: true; pubkey: string; eventId: string }
  | { ok: false; reason: Nip98Failure }

const HEX64 = /^[0-9a-f]{64}$/i
const HEX128 = /^[0-9a-f]{128}$/i

/**
 * Decode an `Authorization: Nostr <base64>` header.
 *
 * `Buffer.from(_, "base64")` accepts the standard and URL-safe alphabets alike
 * and ignores padding, so clients that emit either are fine. Returns null for
 * anything that is not a JSON object — the caller reports one failure for every
 * malformed token rather than leaking which part we choked on.
 */
export function decodeNip98Header(header: string | null | undefined): SignedEvent | null {
  if (!header) return null
  const match = /^nostr\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  try {
    const json = Buffer.from(match[1]!, "base64").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed as SignedEvent
  } catch {
    return null
  }
}

/**
 * Does the `u` tag name the URL we actually served?
 *
 * Compares origin, path and query. `new URL` normalises the scheme and host to
 * lowercase and drops a default port, so `https://shop.ar:443/x` and
 * `https://SHOP.ar/x` match — those are the same request by any reading. The
 * path and query are compared byte for byte: a token signed for
 * `?nonce=a` must not authorise `?nonce=b`, and that is the whole point of
 * having the tag.
 */
export function nip98UrlsMatch(tagUrl: string | undefined, requestUrl: string): boolean {
  if (!tagUrl) return false
  try {
    const a = new URL(tagUrl)
    const b = new URL(requestUrl)
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

/**
 * Verify a decoded NIP-98 token against what we know about the request.
 *
 * Ordered cheap-to-expensive, with one hard rule: NOTHING in the event is
 * trusted until the signature checks out. Reading the `u` tag first and
 * short-circuiting on a mismatch would leak, by timing, which URLs a stolen
 * token is valid for.
 */
export function verifyNip98Event(
  event: SignedEvent,
  expect: Nip98Expectation
): Nip98Verdict {
  const no = (reason: Nip98Failure): Nip98Verdict => ({ ok: false, reason })

  if (
    typeof event !== "object" ||
    event === null ||
    !HEX64.test(event.id ?? "") ||
    !HEX64.test(event.pubkey ?? "") ||
    !HEX128.test(event.sig ?? "") ||
    typeof event.created_at !== "number" ||
    !Number.isFinite(event.created_at) ||
    typeof event.kind !== "number" ||
    typeof event.content !== "string" ||
    !Array.isArray(event.tags)
  ) {
    return no("malformed")
  }

  if (event.kind !== KINDS.HTTP_AUTH) return no("wrong-kind")
  if (!verifySignedEvent(event)) return no("bad-signature")
  if (Math.abs(expect.now - event.created_at) > NIP98_MAX_AGE_SECONDS) return no("stale")

  const method = tagValue(event, "method")
  if (!method || method.toUpperCase() !== expect.method.toUpperCase()) {
    return no("method-mismatch")
  }

  if (!nip98UrlsMatch(tagValue(event, "u"), expect.url)) return no("url-mismatch")

  const payload = tagValue(event, "payload")
  if (expect.payloadSha256) {
    // A body without a committed hash is a token that could be replayed to
    // carry ANY body to the same URL — the one thing the tag exists to stop.
    if (!payload || payload.toLowerCase() !== expect.payloadSha256.toLowerCase()) {
      return no("payload-mismatch")
    }
  } else if (payload) {
    // NIP-98 makes the tag optional when there is no body; a client that sends
    // one anyway must not be silently wrong about what it signed.
    if (payload.toLowerCase() !== EMPTY_BODY_SHA256) return no("payload-mismatch")
  }

  return { ok: true, pubkey: event.pubkey.toLowerCase(), eventId: event.id.toLowerCase() }
}

/** sha256(""), for the "signed a payload tag over nothing" case above. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
