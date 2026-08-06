import {
  DB_ERROR,
  fail,
  ok,
  preflight,
  requireAuth,
  requireDb,
  toRedemptionJson,
} from "@/lib/server/coupon-api"
import { listClaims } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Every coupon this merchant has had redeemed, with the order it paid for.
 *
 * This is the closest thing to an orders table in the app. A paid order is
 * still reconstructed from its zap receipt on relays — but an order a coupon
 * took to zero is never paid, never receipted, and would otherwise exist
 * nowhere. The row written at claim time is its only record, and this is how
 * the admin reads it.
 *
 * Its own endpoint rather than a field on `GET /api/coupons`: that response is
 * what the page opens with, and stapling a signed event per redemption to it
 * would make the coupon list grow with the merchant's sales.
 */
export const runtime = "nodejs"

const METHODS = "GET, OPTIONS"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function GET(request: Request) {
  const limit = rateLimit(`coupons-mgmt:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    const claims = await listClaims(db.db, auth.pubkey)
    return ok({ redemptions: claims.map(toRedemptionJson) }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
