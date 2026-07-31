import "server-only"

import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import { timingSafeEqual } from "@/lib/server/timing-safe"

/**
 * Opaque, signed, short-lived handles for outbound URLs.
 *
 * THE POINT: `GET /api/ln/invoice?callback=<any url>` is a textbook open
 * proxy. Everything an attacker needs is the ability to name a host. So the
 * browser never names one — it sends back a token that THIS server minted
 * from a URL it discovered itself, by fetching a `.well-known` document for a
 * Lightning address the merchant published.
 *
 * To point us at an internal host, an attacker would have to own a domain and
 * serve a crafted `.well-known` from it. That is a real cost and an
 * attributable one, and the SSRF agent still refuses the connection.
 */

const SECRET_ENV = process.env.LN_PROXY_SECRET

/**
 * Falls back to a per-process random key when unset.
 *
 * The consequence is honest and small: a redeploy invalidates tokens that are
 * in flight, which surfaces to the customer as "la sesión de pago venció" and
 * a retry button. Failing closed here would be worse — the whole checkout
 * would be dead on any host that forgot the env var.
 */
const SECRET = utf8ToBytes(SECRET_ENV || bytesToHex(sha256(utf8ToBytes(String(Math.random()) + process.pid))))

if (!SECRET_ENV && process.env.NODE_ENV === "production") {
  console.warn(
    "[ln] LN_PROXY_SECRET is unset; payment tokens will not survive a restart."
  )
}

/** What the token authorises. Kept tiny — it rides in a query string. */
export interface TokenPayload {
  /** The URL we are allowed to call. */
  u: string
  /** Kind: callback or verify. A verify token can never be spent as a callback. */
  k: "cb" | "vf"
  /** Millisatoshi bounds, echoed from the LNURL doc. Only meaningful for "cb". */
  min?: number
  max?: number
  /** Expiry, unix ms. */
  exp: number
}

export const TOKEN_TTL_MS = 15 * 60_000

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}

function sign(body: string): string {
  return bytesToHex(hmac(sha256, SECRET, utf8ToBytes(body))).slice(0, 32)
}

export function mintToken(payload: Omit<TokenPayload, "exp">, now: number): string {
  const body = b64url(JSON.stringify({ ...payload, exp: now + TOKEN_TTL_MS }))
  return `${body}.${sign(body)}`
}

export type TokenResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" }

export function readToken(
  token: string | null,
  expectKind: TokenPayload["k"],
  now: number
): TokenResult {
  if (!token) return { ok: false, reason: "malformed" }

  const dot = token.lastIndexOf(".")
  if (dot <= 0) return { ok: false, reason: "malformed" }

  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)

  // Constant-time-ish: compare fixed-length hex of equal length. The window
  // is tiny either way, but there is no reason to leak a prefix.
  if (mac.length !== 32 || !timingSafeEqual(mac, sign(body))) {
    return { ok: false, reason: "bad-signature" }
  }

  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (payload.k !== expectKind) return { ok: false, reason: "bad-signature" }
  if (typeof payload.u !== "string" || !payload.u.startsWith("https://")) {
    return { ok: false, reason: "malformed" }
  }
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { ok: false, reason: "expired" }
  }

  return { ok: true, payload }
}
