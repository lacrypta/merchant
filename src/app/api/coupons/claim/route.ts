import { isValidNonce } from "@/lib/domain/coupon"
import {
  DB_ERROR,
  fail,
  ok,
  preflight,
  requireDb,
  requireManager,
  signVoucher,
  toCouponPayload,
} from "@/lib/server/coupon-api"
import { claimByNonce, getByNonce } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Redeem a coupon. THE claim endpoint the merchant advertises to POS clients.
 *
 * No NIP-98: the nonce IS the credential. Whoever presents it is holding the
 * coupon, which is the whole point of a coupon — the person redeeming it at the
 * counter is a customer, not somebody with an npub and a signer.
 *
 * Two methods, deliberately different:
 *
 *   GET  — read only. "Is this nonce good, and what is it worth?" Our own
 *          storefront calls this the moment a shopper types a code, so it can
 *          show the discount before anything is spent.
 *   POST — consumes it. Called once, at the moment the customer is actually
 *          being charged.
 *
 * Collapsing them into one method would mean a shopper who pastes a code and
 * then abandons the page has burned it.
 */
export const runtime = "nodejs"

const METHODS = "GET, POST"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function GET(request: Request) {
  const limit = rateLimit(`coupon-check:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const nonce = new URL(request.url).searchParams.get("nonce")
  if (!isValidNonce(nonce)) return fail("Falta el cupón.", 400, METHODS)

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  try {
    const found = await getByNonce(db.db, nonce)
    if (!found) return fail("Cupón inexistente.", 404, METHODS)

    const { mint, definition } = found
    const expired =
      definition.expiresAt !== null && definition.expiresAt.getTime() <= Date.now()

    // Always 200 for a nonce we recognise, with the reason in `status`. This is
    // a preview endpoint: the caller wants to render "ya usado" or "vencido",
    // and an HTTP error would make every one of those look like a network fault.
    return ok(
      {
        // Voided outranks expired: a merchant cancelling an issuance is a
        // decision, and telling them "vencido" would send them to change a
        // date that has nothing to do with it.
        status: mint.status === "voided" ? "voided" : expired ? "expired" : mint.status,
        ...toCouponPayload(definition, mint),
        claimedAt: mint.claimedAt ? Math.floor(mint.claimedAt.getTime() / 1000) : null,
      },
      METHODS
    )
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}

export async function POST(request: Request) {
  const limit = rateLimit(`coupon-claim:${clientIp(request)}`, { max: 30, windowMs: 60_000 })
  if (!limit.ok) {
    return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
      retryAfter: limit.retryAfter,
    })
  }

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const manager = requireManager(METHODS)
  if ("response" in manager) return manager.response

  let nonce: unknown
  try {
    const body: unknown = await request.json()
    nonce = (body as { nonce?: unknown } | null)?.nonce
  } catch {
    return fail("Cuerpo inválido.", 400, METHODS)
  }
  if (!isValidNonce(nonce)) return fail("Falta el cupón.", 400, METHODS)

  try {
    const outcome = await claimByNonce(db.db, nonce)
    if (!outcome.ok) {
      if (outcome.reason === "voided") return fail("El cupón fue anulado.", 410, METHODS)
      if (outcome.reason === "expired") return fail("El cupón está vencido.", 410, METHODS)
      return fail("Cupón inexistente.", 404, METHODS)
    }

    const { mint, definition, fresh } = outcome

    /**
     * `claimed` is 200, not a 4xx.
     *
     * A POS that loses our response and retries has to be able to tell "I
     * redeemed this" from "somebody else already did", and the way it does that
     * is by comparing `claimedAt` to when it made the call. An error status
     * would collapse both into "the request failed".
     */
    return ok(
      {
        status: fresh ? "success" : "claimed",
        claimedAt: mint.claimedAt ? Math.floor(mint.claimedAt.getTime() / 1000) : null,
        ...toCouponPayload(definition, mint),
        voucher: signVoucher(manager.manager, definition, mint, "claimed"),
      },
      METHODS
    )
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
