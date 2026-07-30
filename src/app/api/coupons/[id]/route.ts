import type { NextResponse } from "next/server"

import {
  MAX_COUPON_USES,
  normalizeCouponDescription,
  normalizeCouponImageUrl,
  normalizeCouponName,
  parseBenefit,
} from "@/lib/domain/coupon"
import {
  DB_ERROR,
  fail,
  isUuid,
  ok,
  parseBody,
  parseTimestamp,
  preflight,
  requireAuth,
  requireDb,
  toDefinitionJson,
} from "@/lib/server/coupon-api"
import {
  deleteOrArchiveDefinition,
  listDefinitions,
  patchDefinition,
} from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * Edit or retire one coupon definition.
 *
 * Both handlers scope every statement by the authenticated pubkey, so a coupon
 * belonging to somebody else is indistinguishable from one that does not exist —
 * which is the correct answer to give a stranger probing UUIDs.
 */
export const runtime = "nodejs"

const METHODS = "PATCH, DELETE"

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

const NOT_FOUND = "No encontramos ese cupón."

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const stop = limited(request)
  if (stop) return stop

  const { id } = await ctx.params
  if (!isUuid(id)) return fail(NOT_FOUND, 404, METHODS)

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  const body = parseBody(auth.rawBody)
  if (!body) return fail("Cuerpo inválido.", 400, METHODS)

  const patch: Parameters<typeof patchDefinition>[3] = {}

  if (body.name !== undefined) {
    const name = normalizeCouponName(body.name)
    if (!name) return fail("Poné un nombre de hasta 80 caracteres.", 400, METHODS)
    patch.name = name
  }

  if (body.description !== undefined) {
    const description = normalizeCouponDescription(body.description)
    if (description === null) {
      return fail("La descripción puede tener hasta 500 caracteres.", 400, METHODS)
    }
    patch.description = description
  }

  if (body.image !== undefined) {
    const imageUrl = normalizeCouponImageUrl(body.image)
    if (imageUrl === undefined) {
      return fail("La imagen tiene que ser una URL https.", 400, METHODS)
    }
    patch.imageUrl = imageUrl
  }

  if (body.benefit !== undefined) {
    const benefit = parseBenefit(body.benefit)
    if (!benefit.ok) return fail(`El cupón no es válido: ${benefit.reason}.`, 400, METHODS)
    patch.benefit = benefit.value
  }

  if (body.maxUses !== undefined) {
    const maxUses = body.maxUses
    if (maxUses === null) {
      patch.maxUses = null
    } else if (
      typeof maxUses !== "number" ||
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > MAX_COUPON_USES
    ) {
      return fail("El máximo de usos no es válido.", 400, METHODS)
      // Lowering it below what has already been minted is ALLOWED: it stops
      // further minting without touching coupons already handed out.
    } else {
      patch.maxUses = maxUses
    }
  }

  if (body.expiresAt !== undefined) {
    const expires = parseTimestamp(body.expiresAt)
    if (!expires.ok) {
      return fail("La fecha de vencimiento no es válida.", 400, METHODS)
    }
    // A past date is legal here on purpose: it is how a merchant kills coupons
    // that are already out in the world.
    patch.expiresAt = expires.value
  }

  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return fail("El estado de archivado no es válido.", 400, METHODS)
    }
    patch.archived = body.archived
  }

  if (Object.keys(patch).length === 0) return fail("No hay nada para cambiar.", 400, METHODS)

  try {
    const row = await patchDefinition(db.db, auth.pubkey, id, patch)
    if (!row) return fail(NOT_FOUND, 404, METHODS)

    // Re-read the counts so the client's row is complete rather than half-fresh.
    const all = await listDefinitions(db.db, auth.pubkey)
    const withCounts = all.find((d) => d.id === id) ?? { ...row, claimed: 0 }
    return ok({ coupon: toDefinitionJson(withCounts) }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}

/**
 * Delete when nothing was ever minted; archive otherwise.
 *
 * A definition with coupons in circulation cannot be deleted — the nonces in
 * people's phones point at it, and they are still owed. Archiving stops new
 * mints and leaves those claimable, which is what a merchant means by "quitar
 * este cupón" in every case we could think of.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const stop = limited(request)
  if (stop) return stop

  const { id } = await ctx.params
  if (!isUuid(id)) return fail(NOT_FOUND, 404, METHODS)

  const db = requireDb(METHODS)
  if ("response" in db) return db.response

  const auth = await requireAuth(request, METHODS)
  if ("response" in auth) return auth.response

  try {
    const outcome = await deleteOrArchiveDefinition(db.db, auth.pubkey, id)
    if (outcome === "not-found") return fail(NOT_FOUND, 404, METHODS)
    return ok({ deleted: outcome === "deleted", archived: outcome === "archived" }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
