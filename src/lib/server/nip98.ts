import "server-only"

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import {
  NIP98_MAX_AGE_SECONDS,
  decodeNip98Header,
  verifyNip98Event,
  type Nip98Failure,
} from "@/lib/domain/nip98"
import { nowSeconds } from "@/lib/nostr/created-at"
import { MAX_AUTH_HEADER_BYTES, MAX_BODY_BYTES, readBoundedBody } from "@/lib/server/http"

/**
 * The request-facing half of NIP-98. The pure verification lives in
 * src/lib/domain/nip98.ts.
 *
 * Every coupon management route calls `requireNip98` first and treats the
 * returned pubkey as the tenant: rows are scoped to it, and there is no
 * "current user" anywhere else. That makes the URL comparison below the actual
 * security boundary, which is why it does not trust forwarded headers when it
 * has been told what this deployment's origin is.
 */

// Re-exported from http.ts, where the body reader that enforces them lives.
export { MAX_AUTH_HEADER_BYTES, MAX_BODY_BYTES }

export type Nip98Reason = Nip98Failure | "missing" | "replay" | "too-large"

export type Nip98Auth =
  | { ok: true; pubkey: string; rawBody: string }
  | { ok: false; status: 401 | 413; error: string; reason: Nip98Reason }

const INVALID = "La autorización NIP-98 no es válida."

/**
 * Event ids we have already honoured.
 *
 * Same honesty caveats as rate-limit.ts: per-process, lost on a cold start, not
 * shared between instances. It raises the cost of replaying a token somebody
 * sniffed; it does not enforce. The real protection is that a token is bound to
 * one URL, one method and one body, and expires in a minute.
 *
 * TTL is twice the freshness window: past that, check 4 in verifyNip98Event
 * rejects the token anyway, so remembering it longer only grows the map.
 *
 * WHAT THIS ASKS OF CLIENTS: every token must be a distinct event. All the
 * other inputs are deterministic and `created_at` is only accurate to a second,
 * so two identical requests in the same second hash to the same id and the
 * second is refused with `reason: "replay"`. Our own client puts a random
 * `nonce` tag in the event (src/lib/nostr/nip98.ts); a third-party POS minting
 * several coupons per second has to do the same. It is documented in the README.
 */
const REPLAY_TTL_MS = NIP98_MAX_AGE_SECONDS * 2 * 1000 + 30_000
const SWEEP_THRESHOLD = 5_000
const seen = new Map<string, number>()

function alreadySeen(eventId: string, now: number): boolean {
  if (seen.size > SWEEP_THRESHOLD) {
    for (const [id, expiresAt] of seen) if (expiresAt <= now) seen.delete(id)
  }
  const expiresAt = seen.get(eventId)
  if (expiresAt !== undefined && expiresAt > now) return true
  seen.set(eventId, now + REPLAY_TTL_MS)
  return false
}

/** Test seam. Never call from application code. */
export function __resetNip98Replay(): void {
  seen.clear()
}

/**
 * The URL a client would have signed for this request.
 *
 * When NEXT_PUBLIC_APP_URL is set it is the ONLY origin we accept, and the
 * forwarded headers are ignored entirely — otherwise anyone could send
 * `x-forwarded-host: evil.example`, and a token signed for evil.example's mint
 * endpoint would authenticate here. Path and query always come from the request
 * itself, which no header can influence.
 *
 * Without the env var we fall back to the forwarded headers so `npm run dev`
 * and a bare `next start` behind a reverse proxy both work. Production
 * deployments should set it; the README says so.
 */
export function externalUrl(request: Request): string {
  const url = new URL(request.url)
  const configured = process.env.NEXT_PUBLIC_APP_URL

  if (configured) {
    try {
      return `${new URL(configured).origin}${url.pathname}${url.search}`
    } catch {
      /* misconfigured — fall through to the headers rather than 500 */
    }
  }

  // First value only: chained proxies append, so later entries are hops.
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(/:$/, "")
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    url.host

  return `${proto}://${host}${url.pathname}${url.search}`
}

/**
 * Authenticate a request and hand back its body.
 *
 * The body is read HERE and returned as a string, because a Request body can
 * only be consumed once and the payload hash has to be computed over exactly
 * the bytes the route will parse. Routes must use `rawBody` rather than calling
 * request.json() themselves.
 */
export async function requireNip98(request: Request): Promise<Nip98Auth> {
  const header = request.headers.get("authorization")
  if (!header) {
    return {
      ok: false,
      status: 401,
      error: "Falta la autorización NIP-98.",
      reason: "missing",
    }
  }
  if (header.length > MAX_AUTH_HEADER_BYTES) {
    return { ok: false, status: 401, error: INVALID, reason: "too-large" }
  }

  const body = await readBoundedBody(request)
  if (!body.ok) return body
  const { rawBody } = body

  const event = decodeNip98Header(header)
  if (!event) return { ok: false, status: 401, error: INVALID, reason: "malformed" }

  const verdict = verifyNip98Event(event, {
    url: externalUrl(request),
    method: request.method,
    payloadSha256: rawBody ? bytesToHex(sha256(utf8ToBytes(rawBody))) : undefined,
    now: nowSeconds(),
  })
  if (!verdict.ok) {
    return { ok: false, status: 401, error: INVALID, reason: verdict.reason }
  }

  if (alreadySeen(verdict.eventId, Date.now())) {
    return { ok: false, status: 401, error: INVALID, reason: "replay" }
  }

  return { ok: true, pubkey: verdict.pubkey, rawBody }
}
