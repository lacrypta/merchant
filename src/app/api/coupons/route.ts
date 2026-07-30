import type { NextResponse } from "next/server"

import {
  normalizeCouponDescription,
  normalizeCouponImageUrl,
  normalizeCouponName,
  parseBenefit,
  MAX_COUPON_USES,
} from "@/lib/domain/coupon"
import {
  DB_ERROR,
  fail,
  ok,
  parseBody,
  parseTimestamp,
  preflight,
  requireAuth,
  requireDb,
  toDefinitionJson,
  toMinterJson,
} from "@/lib/server/coupon-api"
import {
  createDefinition,
  listDefinitions,
  getDiscovery,
  listMinters,
} from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * The merchant's own coupons.
 *
 * GET returns definitions AND authorized minters in one response. That is not
 * laziness: every request costs a NIP-98 signature, and on a NIP-46 bunker each
 * signature is a round trip to the merchant's phone. Two endpoints would mean
 * two taps to open one page.
 */
export const runtime = "nodejs"

const METHODS = "GET, POST"

export async function OPTIONS() {
  return preflight(METHODS)
}

function limited(request: Request): NextResponse | null {
  const limit = rateLimit(`coupons-mgmt:${clientIp(request)}`, { max: 60, windowMs: 60_000 })
  if (limit.ok) return null
  return fail("Demasiados pedidos. Probá de nuevo en unos segundos.", 429, METHODS, {
    retryAfter: limit.retryAfter,
  })
}

export async function GET(request: Request) {
  const stop = limited(request)
  if (stop) return stop

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    // Three reads, one signature. The discovery event rides along because the
    // page cannot render its header without knowing whether the service is
    // activated, and a second NIP-98 request would mean a second bunker prompt.
    const [definitions, minters, discovery] = await Promise.all([
      listDefinitions(db.db, auth.pubkey),
      listMinters(db.db, auth.pubkey),
      getDiscovery(db.db, auth.pubkey),
    ])
    return ok(
      {
        coupons: definitions.map(toDefinitionJson),
        minters: minters.map(toMinterJson),
        discovery: discovery?.event ?? null,
      },
      METHODS
    )
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}

export async function POST(request: Request) {
  const stop = limited(request)
  if (stop) return stop

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  const body = parseBody(auth.rawBody)
  if (!body) return fail("Cuerpo inválido.", 400, METHODS)

  const name = normalizeCouponName(body.name)
  if (!name) return fail("Poné un nombre de hasta 80 caracteres.", 400, METHODS)

  const description = normalizeCouponDescription(body.description)
  if (description === null) {
    return fail("La descripción puede tener hasta 500 caracteres.", 400, METHODS)
  }

  const imageUrl = normalizeCouponImageUrl(body.image)
  if (imageUrl === undefined) return fail("La imagen tiene que ser una URL https.", 400, METHODS)

  const benefit = parseBenefit(body.benefit)
  if (!benefit.ok) return fail(`El cupón no es válido: ${benefit.reason}.`, 400, METHODS)

  const maxUses = body.maxUses ?? null
  if (
    maxUses !== null &&
    (typeof maxUses !== "number" ||
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > MAX_COUPON_USES)
  ) {
    return fail("El máximo de usos no es válido.", 400, METHODS)
  }

  const expires = parseTimestamp(body.expiresAt)
  if (!expires.ok) return fail("La fecha de vencimiento no es válida.", 400, METHODS)
  // Only on create. PATCH deliberately allows a past date — that is the kill
  // switch for coupons already in circulation.
  if (expires.value && expires.value.getTime() <= Date.now()) {
    return fail("La fecha de vencimiento ya pasó.", 400, METHODS)
  }

  try {
    const row = await createDefinition(db.db, auth.pubkey, {
      name,
      description,
      imageUrl,
      benefit: benefit.value,
      maxUses,
      expiresAt: expires.value,
    })
    return ok({ coupon: toDefinitionJson({ ...row, claimed: 0 }) }, METHODS, 201)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
