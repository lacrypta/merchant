import {
  DB_ERROR,
  fail,
  ok,
  preflight,
  requireAuth,
  requireDb,
  toHexPubkey,
} from "@/lib/server/coupon-api"
import { removeMinter } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Revoke a minter.
 *
 * Coupons they already issued stay valid — they were handed to customers who
 * had nothing to do with this. Revoking stops them issuing more, which is what
 * "sacar a este empleado" means.
 */
export const runtime = "nodejs"

const METHODS = "DELETE"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function DELETE(request: Request, ctx: { params: Promise<{ pubkey: string }> }) {
  const limit = rateLimit(`coupons-mgmt:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const { pubkey: raw } = await ctx.params
  const minterPubkey = toHexPubkey(decodeURIComponent(raw))
  if (!minterPubkey) return fail("Esa clave pública no es válida.", 400, METHODS)

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    const removed = await removeMinter(db.db, auth.pubkey, minterPubkey)
    if (!removed) return fail("Ese emisor no existe.", 404, METHODS)
    return ok({ removed: true }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
