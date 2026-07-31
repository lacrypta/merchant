import "server-only"

import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import { timingSafeEqual } from "@/lib/server/timing-safe"

/**
 * The merchant's session, as an HS256 JWT.
 *
 * WHAT THIS BUYS: today every call to the coupon API costs a NIP-98 signature.
 * On NIP-07 that is a popup per click; on a NIP-46 bunker it is a 3-15 second
 * round trip and a tap on a phone. Editing three coupons is six authorisations.
 * The merchant signs once, and this token stands in for the rest of the shift.
 *
 * WHAT IT COSTS, stated plainly because it is a real trade and not a win:
 * NIP-98 binds a token to one pubkey, one URL, one method, one body hash, sixty
 * seconds, and a single use. This binds a pubkey and an expiry. Stealing one
 * buys everything that pubkey can do until it expires. The mitigations are the
 * TTL below, sessionStorage on the client (dies with the tab), and TLS — and
 * NIP-98 is still accepted everywhere, so nothing here weakens a POS.
 *
 * Modelled on signed-url.ts, which already mints HMAC-signed handles for the
 * LNURL proxy. Three deliberate divergences from it, each noted where it
 * happens: full-length MAC, seconds instead of milliseconds, three segments.
 */

const SECRET_ENV = process.env.SESSION_JWT_SECRET

/**
 * Random per-process key when unset — signed-url.ts's choice, not
 * coupon-manager.ts's hard failure.
 *
 * What separates the two precedents is what a random key silently invalidates.
 * The manager nsec signs PUBLISHED, long-lived artifacts — vouchers a POS will
 * verify next month, a discovery event other clients read — so a rotating key
 * breaks them invisibly and much later: it must fail loudly. A session is
 * ephemeral and has a retry path, so the worst case is one extra signature.
 *
 * The multi-instance footgun is worse here than for LNURL handles, though, and
 * the warning says so: behind a load balancer with no shared secret, a token
 * minted by instance A is refused by B, so the client re-mints on roughly every
 * other request. That is worse than having no session at all. What keeps it
 * survivable rather than catastrophic is the client's one-retry rule — the
 * degenerate case costs a wasted round trip, never a loop.
 */
const SECRET = utf8ToBytes(
  SECRET_ENV || bytesToHex(sha256(utf8ToBytes(String(Math.random()) + process.pid)))
)

if (!SECRET_ENV && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] SESSION_JWT_SECRET is unset; sessions will not survive a restart, " +
      "and behind more than one instance they will be rejected on almost every request."
  )
}

/**
 * Twelve hours: one retail shift.
 *
 * A cashier gets prompted at most once per opening, which is the entire point
 * on a bunker. An hour would mean a prompt every hour, and a bunker connection
 * that has quietly dropped turns each of those into a hard failure. Longer than
 * a shift buys nothing — sessionStorage already ends the session with the tab.
 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

/**
 * Deliberately three claims.
 *
 * No `jti`: it is only useful with server-side state — a revocation list — and
 * there is none. Carrying one would advertise a capability we do not implement.
 * No `iss`/`aud`: one issuer, one audience, and a dedicated secret makes
 * cross-service confusion impossible by construction. No scope claim either:
 * every route accepts this token, and policy at the enforcement point cannot
 * drift out of sync with itself the way a copy inside the token can.
 */
export interface SessionClaims {
  /** Lowercase hex. THE tenant — the same value requireNip98 returns. */
  sub: string
  /** Informational. Type-checked, never enforced: it is our own clock. */
  iat: number
  exp: number
}

export interface MintedSession {
  token: string
  /** Unix SECONDS. Echoed to the client so it never parses the token itself. */
  expiresAt: number
}

/**
 * `{"alg":"HS256","typ":"JWT"}`, pre-encoded.
 *
 * We are our own only issuer, so byte equality against this constant is the
 * strongest AND cheapest possible `alg` check: `alg:none`, an HS512 header
 * carrying a valid HS256 tag, and key-order permutations all die before
 * anything is parsed, and the verifier never reads `alg` to decide anything.
 */
const HEADER_B64 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}

/**
 * Full 32 bytes, unlike signed-url.ts's 128-bit truncation.
 *
 * A fifteen-minute URL handle can afford to throw half the tag away. A
 * twelve-hour identity should not — and a truncated hex tag is not a JWT.
 */
function sign(body: string): string {
  return Buffer.from(hmac(sha256, SECRET, utf8ToBytes(body))).toString("base64url")
}

/**
 * `now` is unix SECONDS here, and MILLISECONDS in signed-url.ts.
 *
 * Not an oversight: `iat`/`exp` are seconds by RFC 7519, and every caller
 * already holds `nowSeconds()`. The two modules sit in the same directory, so
 * mixing them up is a silent 1000× expiry bug — which is exactly why it is
 * written down here.
 */
export function mintSessionToken(pubkey: string, now: number): MintedSession {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    throw new Error("mintSessionToken necesita un pubkey hex de 64 caracteres")
  }
  const expiresAt = now + SESSION_TTL_SECONDS
  const claims: SessionClaims = { sub: pubkey.toLowerCase(), iat: now, exp: expiresAt }
  const body = `${HEADER_B64}.${b64url(JSON.stringify(claims))}`
  return { token: `${body}.${sign(body)}`, expiresAt }
}

export type SessionTokenResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad-alg" | "bad-signature" | "expired" }

/**
 * Verify a session token.
 *
 * The order below is the security-critical part, and it is signed-url.ts's
 * discipline verbatim: THE SIGNATURE IS CHECKED BEFORE ANYTHING IN THE PAYLOAD
 * IS PARSED. A verifier that decodes first is a verifier that hands attacker
 * bytes to JSON.parse and to whatever reads the result.
 *
 * The MAC is computed over the RECEIVED segment bytes, never over a re-encode:
 * `Buffer.from(s, "base64url")` is lenient — it takes the standard alphabet and
 * ignores padding — so decoding and re-encoding to compare would be forgeable.
 */
export function readSessionToken(token: string | null, now: number): SessionTokenResult {
  if (!token) return { ok: false, reason: "malformed" }

  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((p) => !p)) {
    return { ok: false, reason: "malformed" }
  }
  const [header, payload, mac] = parts as [string, string, string]

  if (header !== HEADER_B64) return { ok: false, reason: "bad-alg" }
  if (!timingSafeEqual(mac, sign(`${header}.${payload}`))) {
    return { ok: false, reason: "bad-signature" }
  }

  let claims: SessionClaims
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "malformed" }
    }
    claims = parsed as SessionClaims
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (
    typeof claims.sub !== "string" ||
    !/^[0-9a-f]{64}$/.test(claims.sub) ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp)
  ) {
    return { ok: false, reason: "malformed" }
  }

  // `<=`, not `<`: RFC 7519 says a token MUST NOT be accepted ON or after
  // `exp`. A deliberate divergence from signed-url.ts, which uses `<`.
  if (claims.exp <= now) return { ok: false, reason: "expired" }

  return { ok: true, claims }
}

/** `Authorization: Bearer <jwt>` → the jwt. Null for any other scheme. */
export function bearerFromHeader(header: string | null): string | null {
  const match = /^bearer\s+(.+)$/i.exec(header?.trim() ?? "")
  return match ? match[1]!.trim() : null
}
