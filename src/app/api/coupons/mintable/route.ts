import { nip19 } from "nostr-tools"

import { benefitFromColumns } from "@/lib/domain/coupon"
import {
  DB_ERROR,
  fail,
  ok,
  preflight,
  requireAuth,
  requireDb,
} from "@/lib/server/coupon-api"
import { listMintableFor } from "@/lib/server/coupon-store"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

/**
 * What the authenticated npub may mint right now, across every merchant that
 * authorised them.
 *
 * This is the POS picker: a cashier's terminal signs one NIP-98 token, gets the
 * list of coupons it is allowed to issue, and shows them as buttons. Coupons
 * that are archived, expired or used up are filtered out server-side, because a
 * terminal showing an option that always fails is worse than not showing it.
 */
export const runtime = "nodejs"

const METHODS = "GET"

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
    const rows = await listMintableFor(db.db, auth.pubkey)
    return ok(
      {
        coupons: rows.flatMap((row) => {
          const benefit = benefitFromColumns(row)
          // A definition we cannot state the terms of is not offerable.
          if (!benefit.ok) return []
          return [
            {
              id: row.id,
              name: row.name,
              description: row.description,
              image: row.imageUrl,
              coupon: benefit.value,
              npub: nip19.npubEncode(row.ownerPubkey),
              remaining: row.maxUses === null ? null : row.maxUses - row.mintedCount,
              expiresAt: row.expiresAt ? Math.floor(row.expiresAt.getTime() / 1000) : null,
            },
          ]
        }),
      },
      METHODS
    )
  } catch {
    return fail(DB_ERROR, 503, METHODS)
  }
}
