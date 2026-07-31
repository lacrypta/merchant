import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

import type { Benefit } from "@/lib/domain/coupon"
import type { SignedEvent } from "@/lib/nostr/types"

/**
 * The coupon tables — the first server-side state in this app.
 *
 * Everything else here lives on nostr relays, which is right for a catalog: it
 * is the merchant's data and it is meant to be readable by anyone. A coupon is
 * the opposite. "Has this nonce been redeemed?" has to have exactly one answer
 * at the instant two tills ask it, and relays are eventually-consistent by
 * design. That is the whole reason for this file.
 *
 * Pubkeys are stored as lowercase 64-char hex — npub is a display encoding and
 * never a key here, matching src/lib/server/nip05.ts.
 */

export const couponType = pgEnum("coupon_type", [
  "percent",
  "fixed",
  "multibuy",
  "buy_x_get_y",
])

/**
 * `voided` is a merchant revoking an issuance that was never redeemed. The row
 * survives on purpose: a till that scans a cancelled QR should be told it was
 * cancelled, which a deleted row could only answer with "no existe".
 */
export const couponMintStatus = pgEnum("coupon_mint_status", [
  "minted",
  "claimed",
  "voided",
])

/**
 * What the merchant authored: a coupon that can be minted N times.
 *
 * The benefit is spread across typed nullable columns rather than a single
 * jsonb blob so the table can be read, indexed and corrected with plain SQL
 * when something goes wrong at 3am. `parseBenefit` in the domain layer is what
 * guarantees the right subset is populated for each `type`.
 */
export const couponDefinitions = pgTable(
  "coupon_definitions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerPubkey: varchar("owner_pubkey", { length: 64 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    description: varchar("description", { length: 500 }).notNull().default(""),
    imageUrl: varchar("image_url", { length: 500 }),
    type: couponType("type").notNull(),

    /** percent: 1..100 */
    percent: integer("percent"),
    /** fixed: pg returns numeric as a STRING — benefitFromColumns parses it. */
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: varchar("currency", { length: 3 }),
    /** multibuy: pay `payQty` of every `buyQty`. productD null ⇒ every line. */
    buyQty: integer("buy_qty"),
    payQty: integer("pay_qty"),
    /** Scope for percent/fixed/multibuy. Null ⇒ every product. */
    productDs: jsonb("product_ds").$type<string[]>(),
    /** buy_x_get_y: one `giftProductD` free when `buyProductD` is in the cart. */
    buyProductD: uuid("buy_product_d"),
    giftProductD: uuid("gift_product_d"),

    /** null ⇒ unlimited mints. */
    maxUses: integer("max_uses"),
    /**
     * Incremented inside the guarded UPDATE that mints, which is what makes the
     * cap hold under concurrency — counting rows in coupon_mints would race.
     */
    mintedCount: integer("minted_count").notNull().default(0),
    /** Blocks minting AND claiming. The kill switch for coupons already out. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * Blocks minting ONLY. A coupon already in somebody's phone stays
     * claimable: the merchant handed it out and should honour it.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("coupon_definitions_owner_idx").on(t.ownerPubkey)]
)

/**
 * One issued coupon. The nonce is the bearer credential.
 *
 * `benefit` is a SNAPSHOT taken at mint time, not a pointer to the definition's
 * current columns. The manager key signs a voucher over it, so a later edit to
 * the definition must not silently change what an outstanding coupon promises —
 * that would make every voucher already in the wild unverifiable.
 */
export const couponMints = pgTable(
  "coupon_mints",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    definitionId: uuid("definition_id")
      .notNull()
      /**
       * RESTRICT, not CASCADE: the delete route archives a definition that has
       * mints and hard-deletes only a pristine one, so "the definition vanished
       * between mint and claim" is impossible by construction rather than by
       * convention.
       */
      .references(() => couponDefinitions.id, { onDelete: "restrict" }),
    nonce: varchar("nonce", { length: 32 }).notNull(),
    benefit: jsonb("benefit").$type<Benefit>().notNull(),
    mintedByPubkey: varchar("minted_by_pubkey", { length: 64 }).notNull(),
    mintedAt: timestamp("minted_at", { withTimezone: true }).notNull().defaultNow(),
    status: couponMintStatus("status").notNull().default("minted"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("coupon_mints_nonce_unique").on(t.nonce),
    index("coupon_mints_definition_idx").on(t.definitionId, t.status),
  ]
)

/**
 * Who may mint on an owner's behalf — the cashier's phone, a POS terminal.
 *
 * The owner is never a row here: their right to mint their own coupons is
 * implicit, and storing it would leave the UI showing the merchant to
 * themselves as one of their own employees.
 */
export const couponMinters = pgTable(
  "coupon_minters",
  {
    ownerPubkey: varchar("owner_pubkey", { length: 64 }).notNull(),
    minterPubkey: varchar("minter_pubkey", { length: 64 }).notNull(),
    label: varchar("label", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerPubkey, t.minterPubkey] }),
    /** "Which owners let ME mint?" — the /mintable lookup for POS clients. */
    index("coupon_minters_minter_idx").on(t.minterPubkey),
  ]
)

/**
 * The merchant's signed discovery event, kept verbatim.
 *
 * Relays are not storage we control: they drop events, they go away, and a read
 * can miss one that is genuinely out there. Keeping the SIGNED event here means
 * two things a relay round trip cannot give us — the coupons page knows it is
 * activated the instant it loads, and a re-broadcast needs no new signature,
 * because the bytes we would publish are the bytes we already have.
 *
 * One row per merchant: kind 30078 is addressable, so there is only ever one
 * current announcement per `d`.
 */
export const couponDiscovery = pgTable("coupon_discovery", {
  ownerPubkey: varchar("owner_pubkey", { length: 64 }).primaryKey(),
  event: jsonb("event").$type<SignedEvent>().notNull(),
  /** The event's own created_at, so a stale copy can never overwrite a newer one. */
  eventCreatedAt: integer("event_created_at").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type CouponDefinitionRow = typeof couponDefinitions.$inferSelect
export type CouponMintRow = typeof couponMints.$inferSelect
export type CouponMinterRow = typeof couponMinters.$inferSelect
export type CouponDiscoveryRow = typeof couponDiscovery.$inferSelect
