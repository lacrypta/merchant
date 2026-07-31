import "server-only"

import { randomBytes } from "node:crypto"

import { and, count, desc, eq, isNull, or, sql } from "drizzle-orm"

import {
  NONCE_LENGTH,
  benefitFromColumns,
  benefitToColumns,
  type Benefit,
} from "@/lib/domain/coupon"
import type { Db } from "@/lib/server/db"
import type { SignedEvent } from "@/lib/nostr/types"
import {
  couponDefinitions,
  couponDiscovery,
  couponMinters,
  couponMints,
  type CouponDefinitionRow,
  type CouponMintRow,
  type CouponDiscoveryRow,
  type CouponMinterRow,
} from "@/lib/server/db/schema"

/**
 * Every SQL statement the coupon system runs.
 *
 * The two that matter are `mintCoupon` and `claimByNonce`. Both are single
 * guarded UPDATEs whose WHERE clause carries the whole precondition, so the
 * database — not this process — decides who wins when two tills act at once.
 * A read-then-write would be a race with money on the other side of it.
 */

/** 16 bytes of entropy. Unguessable, and 22 base64url chars fit any QR. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url")
}

export interface DefinitionWithCounts extends CouponDefinitionRow {
  claimed: number
}

export interface DefinitionInput {
  name: string
  description: string
  imageUrl: string | null
  benefit: Benefit
  maxUses: number | null
  expiresAt: Date | null
}

export type DefinitionPatch = Partial<DefinitionInput> & { archived?: boolean }

// ───────────────────────────────────────────────────────────────────────────
// Definitions
// ───────────────────────────────────────────────────────────────────────────

/**
 * The owner's coupons, newest first, with how many of each have been redeemed.
 *
 * Archived ones are included: the merchant needs to see that a retired coupon
 * still has 12 unclaimed instances in circulation.
 */
export async function listDefinitions(
  db: Db,
  ownerPubkey: string
): Promise<DefinitionWithCounts[]> {
  const claimed = db
    .select({
      definitionId: couponMints.definitionId,
      claimed: count().as("claimed"),
    })
    .from(couponMints)
    .where(eq(couponMints.status, "claimed"))
    .groupBy(couponMints.definitionId)
    .as("claimed_counts")

  const rows = await db
    .select({ definition: couponDefinitions, claimed: claimed.claimed })
    .from(couponDefinitions)
    .leftJoin(claimed, eq(claimed.definitionId, couponDefinitions.id))
    .where(eq(couponDefinitions.ownerPubkey, ownerPubkey))
    .orderBy(desc(couponDefinitions.createdAt))

  return rows.map((r) => ({ ...r.definition, claimed: Number(r.claimed ?? 0) }))
}

export async function getDefinition(
  db: Db,
  ownerPubkey: string,
  id: string
): Promise<CouponDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(couponDefinitions)
    .where(and(eq(couponDefinitions.id, id), eq(couponDefinitions.ownerPubkey, ownerPubkey)))
    .limit(1)
  return row ?? null
}

export async function createDefinition(
  db: Db,
  ownerPubkey: string,
  input: DefinitionInput
): Promise<CouponDefinitionRow> {
  const [row] = await db
    .insert(couponDefinitions)
    .values({
      ownerPubkey,
      name: input.name,
      description: input.description,
      imageUrl: input.imageUrl,
      ...benefitToColumns(input.benefit),
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
    })
    .returning()
  return row!
}

/**
 * Patch a definition. Only the fields present in `patch` are touched.
 *
 * Editing the benefit does NOT change coupons already minted: each mint froze
 * its own copy (see the `benefit` column on coupon_mints), because the manager
 * key already signed a voucher over it.
 */
export async function patchDefinition(
  db: Db,
  ownerPubkey: string,
  id: string,
  patch: DefinitionPatch
): Promise<CouponDefinitionRow | null> {
  const values: Partial<typeof couponDefinitions.$inferInsert> = { updatedAt: new Date() }

  if (patch.name !== undefined) values.name = patch.name
  if (patch.description !== undefined) values.description = patch.description
  if (patch.imageUrl !== undefined) values.imageUrl = patch.imageUrl
  if (patch.benefit !== undefined) Object.assign(values, benefitToColumns(patch.benefit))
  if (patch.maxUses !== undefined) values.maxUses = patch.maxUses
  if (patch.expiresAt !== undefined) values.expiresAt = patch.expiresAt
  if (patch.archived !== undefined) values.archivedAt = patch.archived ? new Date() : null

  const [row] = await db
    .update(couponDefinitions)
    .set(values)
    .where(and(eq(couponDefinitions.id, id), eq(couponDefinitions.ownerPubkey, ownerPubkey)))
    .returning()
  return row ?? null
}

/**
 * Delete a pristine definition; archive one that has already been minted.
 *
 * Hard-deleting a definition with outstanding coupons would strand every nonce
 * somebody is holding, so the FK is ON DELETE RESTRICT and this is the only
 * path that decides between the two.
 */
export async function deleteOrArchiveDefinition(
  db: Db,
  ownerPubkey: string,
  id: string
): Promise<"deleted" | "archived" | "not-found"> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: couponDefinitions.id })
      .from(couponDefinitions)
      .where(and(eq(couponDefinitions.id, id), eq(couponDefinitions.ownerPubkey, ownerPubkey)))
      .limit(1)
    if (!existing) return "not-found"

    const [{ n }] = await tx
      .select({ n: count() })
      .from(couponMints)
      .where(eq(couponMints.definitionId, id))

    if (Number(n) === 0) {
      await tx.delete(couponDefinitions).where(eq(couponDefinitions.id, id))
      return "deleted"
    }

    await tx
      .update(couponDefinitions)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(couponDefinitions.id, id), isNull(couponDefinitions.archivedAt)))
    return "archived"
  })
}

// ───────────────────────────────────────────────────────────────────────────
// Authorized minters
// ───────────────────────────────────────────────────────────────────────────

export async function listMinters(db: Db, ownerPubkey: string): Promise<CouponMinterRow[]> {
  return db
    .select()
    .from(couponMinters)
    .where(eq(couponMinters.ownerPubkey, ownerPubkey))
    .orderBy(desc(couponMinters.createdAt))
}

/** Idempotent: re-adding an existing minter just updates their label. */
export async function upsertMinter(
  db: Db,
  ownerPubkey: string,
  minterPubkey: string,
  label: string | null
): Promise<CouponMinterRow> {
  const [row] = await db
    .insert(couponMinters)
    .values({ ownerPubkey, minterPubkey, label })
    .onConflictDoUpdate({
      target: [couponMinters.ownerPubkey, couponMinters.minterPubkey],
      set: { label },
    })
    .returning()
  return row!
}

export async function removeMinter(
  db: Db,
  ownerPubkey: string,
  minterPubkey: string
): Promise<boolean> {
  const rows = await db
    .delete(couponMinters)
    .where(
      and(
        eq(couponMinters.ownerPubkey, ownerPubkey),
        eq(couponMinters.minterPubkey, minterPubkey)
      )
    )
    .returning({ minterPubkey: couponMinters.minterPubkey })
  return rows.length > 0
}

/** The owner's own right to mint is implicit and never a row in the table. */
export async function isAuthorizedMinter(
  db: Db,
  definition: Pick<CouponDefinitionRow, "ownerPubkey">,
  pubkey: string
): Promise<boolean> {
  if (definition.ownerPubkey === pubkey) return true
  const [row] = await db
    .select({ minterPubkey: couponMinters.minterPubkey })
    .from(couponMinters)
    .where(
      and(
        eq(couponMinters.ownerPubkey, definition.ownerPubkey),
        eq(couponMinters.minterPubkey, pubkey)
      )
    )
    .limit(1)
  return !!row
}

/**
 * May this pubkey mint this definition?
 *
 * Separates "no such coupon" from "not your coupon" so the mint route can say
 * which. That distinction is safe to expose: a POS operator who gets 403 needs
 * to know to ask the merchant for access rather than re-check the id.
 */
export async function mintPermission(
  db: Db,
  definitionId: string,
  pubkey: string
): Promise<"allowed" | "denied" | "not-found"> {
  const [row] = await db
    .select({ ownerPubkey: couponDefinitions.ownerPubkey })
    .from(couponDefinitions)
    .where(eq(couponDefinitions.id, definitionId))
    .limit(1)
  if (!row) return "not-found"
  return (await isAuthorizedMinter(db, row, pubkey)) ? "allowed" : "denied"
}

/** Everything `pubkey` may mint right now — the POS picker. */
export async function listMintableFor(
  db: Db,
  pubkey: string
): Promise<CouponDefinitionRow[]> {
  const authorized = db
    .select({ ownerPubkey: couponMinters.ownerPubkey })
    .from(couponMinters)
    .where(eq(couponMinters.minterPubkey, pubkey))

  return db
    .select()
    .from(couponDefinitions)
    .where(
      and(
        or(
          eq(couponDefinitions.ownerPubkey, pubkey),
          sql`${couponDefinitions.ownerPubkey} IN ${authorized}`
        ),
        isNull(couponDefinitions.archivedAt),
        or(
          isNull(couponDefinitions.expiresAt),
          sql`${couponDefinitions.expiresAt} > now()`
        ),
        or(
          isNull(couponDefinitions.maxUses),
          sql`${couponDefinitions.mintedCount} < ${couponDefinitions.maxUses}`
        )
      )
    )
    .orderBy(desc(couponDefinitions.createdAt))
}

// ───────────────────────────────────────────────────────────────────────────
// Minting and claiming
// ───────────────────────────────────────────────────────────────────────────

export type MintOutcome =
  | { ok: true; definition: CouponDefinitionRow; mint: CouponMintRow }
  | { ok: false; reason: "not-found" | "archived" | "expired" | "exhausted" | "corrupt" }

/**
 * Issue one coupon.
 *
 * The cap is enforced by incrementing `minted_count` inside the same UPDATE
 * that checks it. Counting rows first and inserting after would let two
 * simultaneous requests both see "9 of 10 used" and both mint.
 *
 * A zero-row result is ambiguous by design — it means the row was missing OR
 * archived OR expired OR exhausted — so the reason is worked out with a second
 * read. That read is only on the failure path, where an extra round trip costs
 * nothing and a specific message is worth a lot to whoever is holding the till.
 */
export async function mintCoupon(
  db: Db,
  definitionId: string,
  mintedByPubkey: string
): Promise<MintOutcome> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .update(couponDefinitions)
      .set({
        mintedCount: sql`${couponDefinitions.mintedCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(couponDefinitions.id, definitionId),
          isNull(couponDefinitions.archivedAt),
          or(
            isNull(couponDefinitions.maxUses),
            sql`${couponDefinitions.mintedCount} < ${couponDefinitions.maxUses}`
          ),
          or(
            isNull(couponDefinitions.expiresAt),
            sql`${couponDefinitions.expiresAt} > now()`
          )
        )
      )
      .returning()

    if (!definition) {
      const [row] = await tx
        .select()
        .from(couponDefinitions)
        .where(eq(couponDefinitions.id, definitionId))
        .limit(1)
      if (!row) return { ok: false as const, reason: "not-found" as const }
      if (row.archivedAt) return { ok: false as const, reason: "archived" as const }
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        return { ok: false as const, reason: "expired" as const }
      }
      return { ok: false as const, reason: "exhausted" as const }
    }

    // Freeze the benefit: the voucher we are about to sign commits to it, and a
    // later edit to the definition must not change what this coupon promises.
    const benefit = benefitFromColumns(definition)
    if (!benefit.ok) {
      // Refuse rather than issue a coupon whose terms we cannot state. The
      // transaction rolls back, so minted_count is not consumed either.
      throw new CorruptDefinitionError(definitionId, benefit.reason)
    }

    const [mint] = await tx
      .insert(couponMints)
      .values({
        definitionId,
        nonce: newNonce(),
        benefit: benefit.value,
        mintedByPubkey,
      })
      .returning()

    return { ok: true as const, definition, mint: mint! }
  })
}

export class CorruptDefinitionError extends Error {
  constructor(
    readonly definitionId: string,
    readonly reason: string
  ) {
    super(`Coupon definition ${definitionId} has an unusable benefit: ${reason}`)
    this.name = "CorruptDefinitionError"
  }
}

export type ClaimOutcome =
  | { ok: true; fresh: boolean; mint: CouponMintRow; definition: CouponDefinitionRow }
  | { ok: false; reason: "not-found" | "expired" | "voided" }

/**
 * Redeem a nonce, once.
 *
 * `status = 'minted'` in the WHERE clause is the whole concurrency story: two
 * tills scanning the same QR at the same instant produce one UPDATE that
 * returns a row and one that returns nothing, and the second is reported as
 * already claimed. `fresh` tells the caller which of the two they were.
 *
 * Note that an ARCHIVED definition still claims. Archiving stops new mints; a
 * coupon already in somebody's phone was a promise the merchant made.
 */
export async function claimByNonce(db: Db, nonce: string): Promise<ClaimOutcome> {
  const [claimed] = await db
    .update(couponMints)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(
      and(
        eq(couponMints.nonce, nonce),
        eq(couponMints.status, "minted"),
        sql`EXISTS (
          SELECT 1 FROM ${couponDefinitions}
          WHERE ${couponDefinitions.id} = ${couponMints.definitionId}
            AND (${couponDefinitions.expiresAt} IS NULL OR ${couponDefinitions.expiresAt} > now())
        )`
      )
    )
    .returning()

  if (claimed) {
    const definition = await definitionOf(db, claimed.definitionId)
    if (!definition) return { ok: false, reason: "not-found" }
    return { ok: true, fresh: true, mint: claimed, definition }
  }

  const existing = await getByNonce(db, nonce)
  if (!existing) return { ok: false, reason: "not-found" }
  if (existing.mint.status === "voided") return { ok: false, reason: "voided" }
  if (
    existing.definition.expiresAt &&
    existing.definition.expiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, reason: "expired" }
  }
  // Not expired, not voided, not claimable ⇒ somebody already claimed it.
  return { ok: true, fresh: false, mint: existing.mint, definition: existing.definition }
}

async function definitionOf(db: Db, id: string): Promise<CouponDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(couponDefinitions)
    .where(eq(couponDefinitions.id, id))
    .limit(1)
  return row ?? null
}

/** Look up a coupon without consuming it — the checkout's "is this valid?". */
export async function getByNonce(
  db: Db,
  nonce: string
): Promise<{ mint: CouponMintRow; definition: CouponDefinitionRow } | null> {
  const [row] = await db
    .select({ mint: couponMints, definition: couponDefinitions })
    .from(couponMints)
    .innerJoin(couponDefinitions, eq(couponDefinitions.id, couponMints.definitionId))
    .where(eq(couponMints.nonce, nonce))
    .limit(1)
  return row ?? null
}

/** Sanity check for the nonce generator, used by the tests. */
export const NONCE_CHARS = NONCE_LENGTH

// ───────────────────────────────────────────────────────────────────────────
// Discovery event
// ───────────────────────────────────────────────────────────────────────────

/** The merchant's stored announcement, or null if they never activated. */
export async function getDiscovery(
  db: Db,
  ownerPubkey: string
): Promise<CouponDiscoveryRow | null> {
  const [row] = await db
    .select()
    .from(couponDiscovery)
    .where(eq(couponDiscovery.ownerPubkey, ownerPubkey))
    .limit(1)
  return row ?? null
}

/**
 * Store the announcement, newest wins.
 *
 * The `WHERE` on the upsert is what makes a late-arriving older copy harmless:
 * two tabs racing, or a retry of an earlier activation, can never roll the
 * merchant back to endpoints they already replaced. Same rule the relays apply
 * to an addressable event, applied here so both sides agree on which one is
 * current.
 */
export async function upsertDiscovery(
  db: Db,
  ownerPubkey: string,
  event: SignedEvent
): Promise<CouponDiscoveryRow> {
  const [row] = await db
    .insert(couponDiscovery)
    .values({ ownerPubkey, event, eventCreatedAt: event.created_at })
    .onConflictDoUpdate({
      target: couponDiscovery.ownerPubkey,
      set: { event, eventCreatedAt: event.created_at, updatedAt: new Date() },
      where: sql`${couponDiscovery.eventCreatedAt} <= ${event.created_at}`,
    })
    .returning()

  // No row back means the stored copy is newer; return it rather than lying.
  return row ?? (await getDiscovery(db, ownerPubkey))!
}

// ───────────────────────────────────────────────────────────────────────────
// Issued coupons
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every instance of one coupon, newest first.
 *
 * Owner-scoped through the definition rather than by trusting the caller: the
 * nonce is a bearer token, and a listing endpoint that leaked one would hand
 * out free money.
 */
export async function listMints(
  db: Db,
  ownerPubkey: string,
  definitionId: string
): Promise<CouponMintRow[]> {
  return db
    .select({ mint: couponMints })
    .from(couponMints)
    .innerJoin(couponDefinitions, eq(couponDefinitions.id, couponMints.definitionId))
    .where(
      and(
        eq(couponMints.definitionId, definitionId),
        eq(couponDefinitions.ownerPubkey, ownerPubkey)
      )
    )
    .orderBy(desc(couponMints.mintedAt))
    .then((rows) => rows.map((r) => r.mint))
}

export type VoidOutcome =
  | { ok: true; mint: CouponMintRow }
  | { ok: false; reason: "not-found" | "claimed" | "already-voided" }

/**
 * Revoke an issuance that was never redeemed.
 *
 * Guarded on `status = 'minted'` for the same reason claiming is: the till and
 * the merchant can act in the same second, and whoever the database serves
 * first wins. A coupon that was already claimed cannot be undone here — the
 * customer got what they were promised.
 *
 * The cap gets the slot back. A merchant who misclicks "Emitir" on a
 * single-use coupon would otherwise have to go edit the coupon to be able to
 * issue it again, and "this issuance never happened" is exactly what voiding
 * means.
 */
export async function voidMint(
  db: Db,
  ownerPubkey: string,
  definitionId: string,
  nonce: string
): Promise<VoidOutcome> {
  return db.transaction(async (tx) => {
    const [voided] = await tx
      .update(couponMints)
      .set({ status: "voided", voidedAt: new Date() })
      .where(
        and(
          eq(couponMints.nonce, nonce),
          eq(couponMints.definitionId, definitionId),
          eq(couponMints.status, "minted"),
          sql`EXISTS (
            SELECT 1 FROM ${couponDefinitions}
            WHERE ${couponDefinitions.id} = ${couponMints.definitionId}
              AND ${couponDefinitions.ownerPubkey} = ${ownerPubkey}
          )`
        )
      )
      .returning()

    if (voided) {
      await tx
        .update(couponDefinitions)
        .set({
          // Floored at zero: a counter that went negative would let the cap be
          // exceeded, and no arithmetic here is worth that.
          mintedCount: sql`GREATEST(0, ${couponDefinitions.mintedCount} - 1)`,
          updatedAt: new Date(),
        })
        .where(eq(couponDefinitions.id, definitionId))
      return { ok: true, mint: voided }
    }

    // `tx`, not `db`: a second checkout from a pool of five while this
    // transaction still holds one deadlocks under concurrent voids, and reading
    // outside the transaction could disagree with the UPDATE that just ran.
    const existing = await getByNonce(tx, nonce)
    if (
      !existing ||
      existing.mint.definitionId !== definitionId ||
      existing.definition.ownerPubkey !== ownerPubkey
    ) {
      return { ok: false, reason: "not-found" }
    }
    return {
      ok: false,
      reason: existing.mint.status === "claimed" ? "claimed" : "already-voided",
    }
  })
}
