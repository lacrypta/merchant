import {
  DB_ERROR,
  fail,
  ok,
  parseBody,
  preflight,
  requireAuth,
  requireDb,
} from "@/lib/server/coupon-api"
import { upsertDiscovery } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

import {
  isOurCouponDiscovery,
  parseCouponDiscovery,
} from "@/lib/domain/coupon-discovery"
import { verifySignedEvent } from "@/lib/nostr/verify"
import type { SignedEvent } from "@/lib/nostr/types"

/**
 * Keep the merchant's signed announcement.
 *
 * Reading it back is NOT here: it rides along with `GET /api/coupons`, so the
 * page costs one signature instead of two — on a NIP-46 bunker that is one trip
 * to the merchant's phone, not two.
 *
 * We store the event, we do not mint it. The signature is the merchant's and
 * this service could not forge one; all this endpoint can do is remember what
 * they already signed, so it can be re-broadcast later without asking them
 * again.
 */
export const runtime = "nodejs"

const METHODS = "PUT, OPTIONS"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function PUT(request: Request) {
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

  const body = parseBody(auth.rawBody)
  if (!body || typeof body.event !== "object" || body.event === null) {
    return fail("Cuerpo inválido.", 400, METHODS)
  }
  const event = body.event as SignedEvent

  // Shape first, and OUTSIDE the try below: the predicates that follow read
  // `tags` and `content` directly, so `{"event":{}}` used to throw a TypeError
  // that surfaced as a 500 instead of the 400 it is.
  if (
    typeof event.id !== "string" ||
    typeof event.sig !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.content !== "string" ||
    typeof event.kind !== "number" ||
    !Array.isArray(event.tags)
  ) {
    return fail("Cuerpo inválido.", 400, METHODS)
  }

  // Everything below is checked because the caller controls it entirely, and a
  // bad row here would be re-broadcast to relays under the merchant's name.
  if (!isOurCouponDiscovery(event, auth.pubkey)) {
    return fail("Ese evento no es tu anuncio de cupones.", 400, METHODS)
  }
  if (!Number.isInteger(event.created_at) || event.created_at <= 0) {
    return fail("El evento no tiene una fecha válida.", 400, METHODS)
  }
  if (!verifySignedEvent(event)) {
    return fail("La firma del evento no es válida.", 400, METHODS)
  }
  const parsed = parseCouponDiscovery(event.content)
  if (!parsed.ok) {
    return fail(`El anuncio no se puede leer: ${parsed.reason}.`, 400, METHODS)
  }

  try {
    const row = await upsertDiscovery(db.db, auth.pubkey, event)
    return ok({ event: row.event }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
