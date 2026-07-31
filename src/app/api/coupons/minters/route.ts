import {
  DB_ERROR,
  fail,
  ok,
  parseBody,
  preflight,
  requireAuth,
  requireDb,
  resolvePubkeyInput,
  toMinterJson,
} from "@/lib/server/coupon-api"
import { listMinters, upsertMinter } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * The npubs allowed to mint this merchant's coupons — a cashier's phone, a
 * second terminal, a partner shop running its own POS.
 *
 * GET exists for symmetry and for a POS that wants to show the list; the
 * management page gets minters from GET /api/coupons in the same round trip.
 */
export const runtime = "nodejs"

const METHODS = "GET, POST"
const MAX_LABEL = 80

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
    const rows = await listMinters(db.db, auth.pubkey)
    return ok({ minters: rows.map(toMinterJson) }, METHODS)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}

export async function POST(request: Request) {
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
  if (!body) return fail("Cuerpo inválido.", 400, METHODS)

  // npub, nprofile, raw hex or a NIP-05 address. Only the hex is stored — see
  // resolvePubkeyInput for why we never follow the address later.
  const resolved = await resolvePubkeyInput(body.pubkey)
  if (!resolved.ok) return fail(resolved.error, resolved.status, METHODS)
  const minterPubkey = resolved.pubkey

  // The owner's right to mint is implicit. A self-row would show the merchant
  // to themselves as one of their own employees.
  if (minterPubkey === auth.pubkey) {
    return fail("Ya podés emitir tus propios cupones.", 400, METHODS)
  }

  const rawLabel = body.label
  if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== "string") {
    return fail("La etiqueta no es válida.", 400, METHODS)
  }
  const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, MAX_LABEL) : ""

  try {
    const row = await upsertMinter(db.db, auth.pubkey, minterPubkey, label || null)
    return ok({ minter: toMinterJson(row) }, METHODS, 201)
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
