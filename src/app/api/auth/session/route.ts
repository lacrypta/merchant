import { nowSeconds } from "@/lib/nostr/created-at"
import { fail, ok, preflight } from "@/lib/server/http"
import { requireNip98 } from "@/lib/server/nip98"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { mintSessionToken } from "@/lib/server/session-token"

/**
 * Trade one NIP-98 signature for a session.
 *
 * The merchant signs here once and every later call carries the returned
 * bearer, which is the whole point: on a NIP-46 bunker each signature is a
 * round trip and a tap on a phone, and the coupons page used to spend one per
 * request. See session-token.ts for what that trade costs.
 *
 * NOT under /api/coupons: every path there is documented in docs/cupones.md as
 * part of the contract a merchant advertises to third-party tills, and this is
 * not a coupon endpoint. It also needs no database, so it must not import the
 * module that reaches for one.
 *
 * There is no DELETE. Nothing exists server-side to revoke — the token is
 * self-contained and stateless by design — so signing out is the client
 * dropping it. A revocation endpoint would be a lie that returns 204.
 */
export const runtime = "nodejs"

const METHODS = "POST"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function POST(request: Request) {
  /**
   * Its own bucket, deliberately not `coupons-mgmt`: a busy coupons page must
   * not be able to exhaust the login budget, or the other way round. The same
   * caveat as everywhere in rate-limit.ts applies — per-process, best effort.
   * It shapes cost; it does not authorise. Each attempt already costs the
   * caller a valid NIP-98 signature they cannot forge.
   */
  const limit = rateLimit(`auth-session:${clientIp(request)}`, { max: 20, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  /**
   * NIP-98 straight, not `requireAuth` — that one also takes bearers now, and
   * a session that could be renewed with the session it is replacing would
   * never expire.
   */
  const auth = await requireNip98(request)
  if (!auth.ok) {
    return fail(auth.error, auth.status, METHODS, { reason: auth.reason })
  }

  /**
   * No body, on purpose, and worth writing down so nobody adds one later
   * believing it helps: the NIP-98 event already binds `u` and `method`, and
   * hashing a body defends against no replay at all — whoever can repeat the
   * header can repeat the bytes underneath it. What bounds this exchange is
   * the sixty-second window plus the replay cache in nip98.ts, the same pair
   * that already guards minting a coupon.
   */
  if (auth.rawBody) return fail("Este endpoint no lleva cuerpo.", 400, METHODS)

  const { token, expiresAt } = mintSessionToken(auth.pubkey, nowSeconds())

  /**
   * `pubkey` and `expiresAt` are echoed so THE CLIENT NEVER DECODES THE TOKEN.
   * The moment client code reads a claim, someone starts trusting one — and the
   * browser cannot check the signature that would make it true.
   *
   * 200 and not 201: no addressable resource exists afterwards.
   */
  return ok({ token, pubkey: auth.pubkey, expiresAt }, METHODS)
}
