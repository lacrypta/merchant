import "server-only"

import { NextResponse } from "next/server"
import { nip19 } from "nostr-tools"

import {
  benefitFromColumns,
  voucherEventBody,
  type Benefit,
  type VoucherPhase,
} from "@/lib/domain/coupon"
import type { SignedEvent } from "@/lib/nostr/types"
import { getCouponManager, type CouponManager } from "@/lib/server/coupon-manager"
import type { DefinitionWithCounts } from "@/lib/server/coupon-store"
import { getDb, type Db } from "@/lib/server/db"
import { parseNip05, resolveNip05 } from "@/lib/server/nip05"
import type { CouponDefinitionRow, CouponMintRow, CouponMinterRow } from "@/lib/server/db/schema"
import { nowSeconds } from "@/lib/nostr/created-at"
import {
  MAX_AUTH_HEADER_BYTES,
  cors,
  fail,
  noStore,
  ok,
  preflight,
  readBoundedBody,
} from "@/lib/server/http"
import { requireNip98 } from "@/lib/server/nip98"
import { bearerFromHeader, readSessionToken } from "@/lib/server/session-token"

/**
 * The bits every coupon route repeats: CORS, the 503 preconditions, NIP-98, and
 * the JSON shapes.
 *
 * Extracted because there are eight routes and the alternative is eight copies
 * of the same header block — which is how one of them ends up without
 * `Authorization` in the preflight and fails only for cross-origin POS clients.
 */

// The transport-level helpers live in http.ts now that a second family of
// routes needs them; re-exported so every coupon route keeps its imports.
export { cors, fail, noStore, ok, preflight }

// ───────────────────────────────────────────────────────────────────────────
// Preconditions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the database, or the 503 to return instead.
 *
 * Deployments without DATABASE_URL are a supported state — the rest of the app
 * has never needed one — so this is a normal outcome, not an exception.
 */
export function requireDb(methods: string): { db: Db } | { response: NextResponse } {
  const db = getDb()
  if (!db) {
    return { response: fail("La base de datos no está configurada.", 503, methods) }
  }
  return { db }
}

export function requireManager(
  methods: string
): { manager: CouponManager } | { response: NextResponse } {
  const manager = getCouponManager()
  if (!manager) {
    return {
      response: fail("Los cupones no están habilitados en este servidor.", 503, methods),
    }
  }
  return { manager }
}

/**
 * Authenticate, or the 401/413 to return instead.
 *
 * Two schemes reach the same tenant. `Nostr` is a NIP-98 event signed for this
 * exact request — what a third-party POS sends, and what the browser sends once
 * to get a session. `Bearer` is that session (see session-token.ts), which is
 * how the merchant's own dashboard avoids a signature per click.
 *
 * DISPATCHES ON THE SCHEME. Never tries one and falls back to the other,
 * because both read the request body and a Request body can be consumed
 * exactly once: a "try NIP-98, and if it fails try Bearer" shape is a bug that
 * fires the first time somebody reorders the branches.
 *
 * Every route takes both, including mint. Restricting the value-moving one to
 * NIP-98 was tempting and is theatre: the same bearer can POST to
 * /api/coupons/minters, add an attacker's own npub as an authorised issuer, and
 * mint with their own signature. One rule, no exceptions to keep in sync.
 */
export async function requireAuth(
  request: Request,
  methods: string
): Promise<{ pubkey: string; rawBody: string } | { response: NextResponse }> {
  const header = request.headers.get("authorization")

  if (/^bearer\s/i.test(header ?? "")) {
    return requireSession(request, header!, methods)
  }

  const auth = await requireNip98(request)
  if (!auth.ok) {
    // `reason` is machine-readable help for whoever is integrating a POS —
    // "stale" and "url-mismatch" need very different fixes. It leaks nothing:
    // the caller already knows what they sent.
    return {
      response: fail(auth.error, auth.status, methods, { reason: auth.reason }),
    }
  }
  return { pubkey: auth.pubkey, rawBody: auth.rawBody }
}

async function requireSession(
  request: Request,
  header: string,
  methods: string
): Promise<{ pubkey: string; rawBody: string } | { response: NextResponse }> {
  if (header.length > MAX_AUTH_HEADER_BYTES) {
    return {
      response: fail("La sesión no es válida.", 401, methods, { reason: "session-invalid" }),
    }
  }

  /**
   * The body is read before the token is checked so both schemes fail in the
   * same order — header size, then 413 versus 401, then auth. Consistent
   * observable behaviour between them is worth more than skipping a `text()`
   * on a request that turns out to be unauthenticated.
   */
  const body = await readBoundedBody(request)
  if (!body.ok) {
    return { response: fail(body.error, body.status, methods, { reason: body.reason }) }
  }

  const verdict = readSessionToken(bearerFromHeader(header), nowSeconds())
  if (!verdict.ok) {
    /**
     * Only `expired` is told apart, and only so a log says which happened —
     * the client must re-mint on ANY 401 to a bearer request. With the
     * per-process secret fallback, a restart makes every live token fail as
     * `bad-signature`, not `expired`, so a client that branched on the reason
     * would show an error in every open tab on every deploy.
     *
     * The three invalid cases collapse into one message for the same reason
     * requireNip98 collapses its own: no honest caller can act differently on
     * them, and splitting them tells an attacker which half to work on.
     */
    const expired = verdict.reason === "expired"
    return {
      response: fail(
        expired ? "Tu sesión venció. Volvé a firmar." : "La sesión no es válida.",
        401,
        methods,
        { reason: expired ? "session-expired" : "session-invalid" }
      ),
    }
  }

  return { pubkey: verdict.claims.sub, rawBody: body.rawBody }
}

/** Parse a body that requireNip98 already read and hashed. */
export function parseBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody) return {}
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Accept an npub or raw hex; store and compare lowercase hex, always. */
export function toHexPubkey(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  try {
    const decoded = nip19.decode(value)
    if (decoded.type === "npub") return decoded.data.toLowerCase()
    if (decoded.type === "nprofile") return decoded.data.pubkey.toLowerCase()
  } catch {
    /* not an npub */
  }
  return null
}

export type ResolvedPubkey =
  | { ok: true; pubkey: string }
  | { ok: false; error: string; status: 400 | 404 }

/**
 * Anything a human might reasonably type for "who is this": npub, nprofile,
 * raw hex, or a NIP-05 address.
 *
 * The NIP-05 branch is resolved HERE rather than in the browser for two
 * reasons: most merchant domains send no CORS headers, so a browser fetch fails
 * for real handles; and the SSRF hardening lives on this side (see
 * src/lib/server/ssrf.ts) — this is the one path where a caller picks the
 * hostname we connect to.
 *
 * Only the resulting hex is stored. A NIP-05 address can change owner, and a
 * minter list that silently followed that change would hand issuing rights to
 * whoever bought the domain next.
 */
export async function resolvePubkeyInput(raw: unknown): Promise<ResolvedPubkey> {
  const direct = toHexPubkey(raw)
  if (direct) return { ok: true, pubkey: direct }

  const value = typeof raw === "string" ? raw.trim().replace(/^nostr:/i, "") : ""
  if (!value || !parseNip05(value)) {
    return {
      ok: false,
      status: 400,
      error: "Esa clave pública no es válida. Poné un npub, un hex o una dirección NIP-05.",
    }
  }

  try {
    const resolved = await resolveNip05(value)
    if (!resolved) {
      return { ok: false, status: 404, error: `No encontramos ${value} en nostr.` }
    }
    return { ok: true, pubkey: resolved.pubkey.toLowerCase() }
  } catch {
    // Includes SsrfBlockedError — never leak which address was actually hit.
    return { ok: false, status: 400, error: `No pudimos resolver ${value}.` }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

export type ParsedTimestamp = { ok: true; value: Date | null } | { ok: false }

/**
 * Unix seconds in, Date out. Absent or null both mean "no expiry".
 *
 * A tagged result rather than `Date | null | undefined`: overloading undefined
 * to mean both "the caller omitted it" and "the caller sent garbage" made
 * creating a coupon with no expiry date fail as though the date were invalid.
 * Callers that need to tell "omitted" from "explicitly cleared" — PATCH does —
 * check `!== undefined` on the raw body field before calling.
 */
export function parseTimestamp(raw: unknown): ParsedTimestamp {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false }
  const date = new Date(raw * 1000)
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, value: date }
}

const seconds = (date: Date | null): number | null =>
  date ? Math.floor(date.getTime() / 1000) : null

// ───────────────────────────────────────────────────────────────────────────
// JSON shapes
// ───────────────────────────────────────────────────────────────────────────

/** A definition as the management page sees it. */
export interface DefinitionJson {
  id: string
  name: string
  description: string
  image: string | null
  benefit: Benefit | null
  maxUses: number | null
  minted: number
  claimed: number
  expiresAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * `benefit: null` rather than dropping the row.
 *
 * A definition whose columns no longer parse is a real thing that can happen
 * (a hand-edited database, a future version of this app writing a shape we do
 * not know). Hiding it would leave the merchant with a coupon they cannot see,
 * edit or delete; showing it broken lets them fix it.
 */
export function toDefinitionJson(row: DefinitionWithCounts): DefinitionJson {
  const benefit = benefitFromColumns(row)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.imageUrl,
    benefit: benefit.ok ? benefit.value : null,
    maxUses: row.maxUses,
    minted: row.mintedCount,
    claimed: row.claimed,
    expiresAt: seconds(row.expiresAt),
    archivedAt: seconds(row.archivedAt),
    createdAt: seconds(row.createdAt) ?? 0,
    updatedAt: seconds(row.updatedAt) ?? 0,
  }
}

/** One issued coupon, as the management page sees it. */
export interface MintJson {
  nonce: string
  status: "minted" | "claimed" | "voided"
  /** Hex pubkey of whoever issued it. */
  mintedBy: string
  mintedByNpub: string
  mintedAt: number
  claimedAt: number | null
  voidedAt: number | null
}

export function toMintJson(row: CouponMintRow): MintJson {
  return {
    nonce: row.nonce,
    status: row.status,
    mintedBy: row.mintedByPubkey,
    mintedByNpub: nip19.npubEncode(row.mintedByPubkey),
    mintedAt: seconds(row.mintedAt) ?? 0,
    claimedAt: seconds(row.claimedAt),
    voidedAt: seconds(row.voidedAt),
  }
}

export interface MinterJson {
  pubkey: string
  npub: string
  label: string | null
  createdAt: number
}

export function toMinterJson(row: CouponMinterRow): MinterJson {
  return {
    pubkey: row.minterPubkey,
    npub: nip19.npubEncode(row.minterPubkey),
    label: row.label,
    createdAt: seconds(row.createdAt) ?? 0,
  }
}

/**
 * The POS-facing coupon payload.
 *
 * Field names are fixed by the endpoint contract the merchant advertises:
 * `coupon`, `name`, `description`, `npub`, `image`, `nonce`. A POS written
 * against another deployment of this service must work against ours unchanged.
 */
export interface CouponPayloadJson {
  coupon: Benefit
  name: string
  description: string
  /** The OWNER's npub — whose shop the coupon is for. */
  npub: string
  image: string | null
  nonce: string
  expiresAt: number | null
  /**
   * Which definition this instance came from.
   *
   * Not a credential — minting still needs a NIP-98 signature from an
   * authorized npub — and the buyer's order needs it so the merchant can tie a
   * sale back to the campaign that discounted it.
   */
  couponId: string
}

export function toCouponPayload(
  definition: CouponDefinitionRow,
  mint: CouponMintRow
): CouponPayloadJson {
  return {
    couponId: definition.id,
    // The mint's frozen snapshot, NOT the definition's current columns: the
    // voucher was signed over this, and an edit since then must not change it.
    coupon: mint.benefit,
    name: definition.name,
    description: definition.description,
    npub: nip19.npubEncode(definition.ownerPubkey),
    image: definition.imageUrl,
    nonce: mint.nonce,
    expiresAt: seconds(definition.expiresAt),
  }
}

/** Sign the coupon so a POS can verify it without calling us back. */
export function signVoucher(
  manager: CouponManager,
  definition: CouponDefinitionRow,
  mint: CouponMintRow,
  phase: VoucherPhase
): SignedEvent {
  return manager.sign(
    voucherEventBody({
      nonce: mint.nonce,
      owner: definition.ownerPubkey,
      couponId: definition.id,
      name: definition.name,
      description: definition.description,
      image: definition.imageUrl,
      benefit: mint.benefit,
      phase,
      claimedAt: seconds(mint.claimedAt),
      expiresAt: seconds(definition.expiresAt),
    })
  )
}

/** The message for a database failure. Never leaks the driver's own words. */
export const DB_ERROR = "No pudimos procesar el pedido. Probá de nuevo en un rato."
