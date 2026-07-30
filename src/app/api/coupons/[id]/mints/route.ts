import {
  DB_ERROR,
  fail,
  isUuid,
  ok,
  preflight,
  requireAuth,
  requireDb,
  toMintJson,
} from "@/lib/server/coupon-api"
import { listMints } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Every instance of one coupon: when it went out, who issued it, and whether
 * it has been redeemed.
 *
 * Separate from `GET /api/coupons` on purpose. The list of definitions is what
 * the page opens with, and it is small; this can be hundreds of rows for a
 * coupon that has been handed out all month, so it loads when the merchant
 * actually asks for it.
 */
export const runtime = "nodejs"

const METHODS = "GET, OPTIONS"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const limit = rateLimit(`coupons-mgmt:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const { id } = await ctx.params
  if (!isUuid(id)) return fail("No encontramos ese cupón.", 404, METHODS)

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    const mints = await listMints(db.db, auth.pubkey, id)
    return ok({ mints: mints.map(toMintJson) }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
