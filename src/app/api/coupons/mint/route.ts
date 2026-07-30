import {
  DB_ERROR,
  fail,
  isUuid,
  ok,
  parseBody,
  preflight,
  requireAuth,
  requireDb,
  requireManager,
  signVoucher,
  toCouponPayload,
} from "@/lib/server/coupon-api"
import { mintCoupon, mintPermission } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Issue one coupon. THE mint endpoint the merchant advertises to POS clients.
 *
 * Two gates: a valid NIP-98 signature, and the signer being either the coupon's
 * owner or an npub the owner listed. The nonce it returns is a bearer credential
 * — whoever holds it can redeem the coupon — so it exists only in this response
 * and in the database, is never logged, and the response is never cached.
 */
export const runtime = "nodejs"

const METHODS = "POST"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function POST(request: Request) {
  const limit = rateLimit(`coupon-mint:${clientIp(request)}`, { max: 30, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const manager = requireManager(METHODS)
  if ("response" in manager) return manager.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  const body = parseBody(auth.rawBody)
  if (!body) return fail("Cuerpo inválido.", 400, METHODS)

  const couponId = body.couponId
  if (!isUuid(couponId)) return fail("Falta el cupón.", 400, METHODS)

  try {
    const permission = await mintPermission(db.db, couponId, auth.pubkey)
    if (permission === "not-found") return fail("No encontramos ese cupón.", 404, METHODS)
    if (permission === "denied") {
      return fail("No estás autorizado a emitir este cupón.", 403, METHODS)
    }

    const minted = await mintCoupon(db.db, couponId, auth.pubkey)
    if (!minted.ok) {
      switch (minted.reason) {
        case "not-found":
          return fail("No encontramos ese cupón.", 404, METHODS)
        case "archived":
          return fail("El cupón fue archivado.", 410, METHODS)
        case "expired":
          return fail("El cupón está vencido.", 410, METHODS)
        case "exhausted":
          return fail("Se agotaron los cupones disponibles.", 409, METHODS)
        default:
          return fail(DB_ERROR, 503, METHODS)
      }
    }

    return ok(
      {
        ...toCouponPayload(minted.definition, minted.mint),
        voucher: signVoucher(manager.manager, minted.definition, minted.mint, "minted"),
      },
      METHODS
    )
  } catch {
    // Includes CorruptDefinitionError: a coupon whose stored terms no longer
    // parse must not be issued, and the merchant sees it flagged on /coupons.
    return fail(DB_ERROR, 503, METHODS)
  }
}
