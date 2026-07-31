import { isValidNonce } from "@/lib/domain/coupon"
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
import { voidMint } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Void one issued coupon.
 *
 * DELETE, because from the merchant's side the thing they handed out is gone —
 * but the ROW stays. A till that scans a cancelled QR has to be told it was
 * cancelled, and a deleted row could only answer "no existe", which sends the
 * cashier looking for a typo that is not there.
 *
 * Nested under the definition so ownership comes from the path: the nonce alone
 * is a bearer token, and an endpoint that acted on it without checking who owns
 * the coupon would let anyone void anyone's issuance.
 */
export const runtime = "nodejs"

const METHODS = "DELETE, OPTIONS"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; nonce: string }> }
) {
  const limit = rateLimit(`coupons-mgmt:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const { id, nonce } = await ctx.params
  if (!isUuid(id) || !isValidNonce(nonce)) {
    return fail("No encontramos ese cupón emitido.", 404, METHODS)
  }

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    const result = await voidMint(db.db, auth.pubkey, id, nonce)
    if (result.ok) return ok({ mint: toMintJson(result.mint) }, METHODS)

    switch (result.reason) {
      case "claimed":
        // Nothing to undo: the customer already got what they were promised.
        return fail("Ese cupón ya fue canjeado, no se puede anular.", 409, METHODS)
      case "already-voided":
        return fail("Ese cupón ya estaba anulado.", 409, METHODS)
      default:
        return fail("No encontramos ese cupón emitido.", 404, METHODS)
    }
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
