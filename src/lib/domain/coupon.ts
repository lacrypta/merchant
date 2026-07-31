import type { CartLine } from "@/lib/domain/cart"
import { KINDS } from "@/lib/domain/kinds"
import type { EventBody } from "@/lib/domain/product"
import { CURRENCIES, isSupportedCurrency, type Currency } from "@/lib/domain/price"
import { quote, toSats, type Quote, type SatPriceTable } from "@/lib/domain/rates"

/**
 * Coupons: what they promise, and what that is worth against a given cart.
 *
 * Pure — no React, no network, no clock. The server stores these shapes in
 * Postgres and the storefront prices them; both go through this module so a
 * discount can never mean one thing at the till and another in the database.
 */

// ───────────────────────────────────────────────────────────────────────────
// The benefit
// ───────────────────────────────────────────────────────────────────────────

export type CouponType = "percent" | "fixed" | "multibuy" | "buyXgetY"

/**
 * Which products a discount applies to.
 *
 * ABSENT MEANS EVERYTHING. That default is the important half: a merchant who
 * says "10% off" means the store, and making them tick every product to say so
 * would be a worse coupon system. A list narrows it to exactly those products —
 * nothing else in the basket is touched, and the discount is capped at what
 * those lines are actually worth.
 */
export type ProductScope = string[] | undefined

/**
 * What a coupon takes off the bill.
 *
 * A discriminated union rather than a bag of optional fields: "a 2x1 with a
 * percentage" is not a thing, and the type system should say so once here
 * instead of every caller re-checking.
 */
export type Benefit =
  /** A percentage off the basket, or off `productDs` when narrowed. */
  | { type: "percent"; percent: number; productDs?: string[] }
  /** A flat amount off, in the currency the merchant authored it in. */
  | { type: "fixed"; amount: number; currency: Currency; productDs?: string[] }
  /**
   * Pay `payQty` for every `buyQty` of the same product — 2x1 is
   * `{ buyQty: 2, payQty: 1 }`, 3x2 is `{ buyQty: 3, payQty: 2 }`.
   *
   * The promo is counted per line, so a list of products means "2x1 on any of
   * these, each on its own"; absent means the whole store, which is how a
   * "2x1 en toda la tienda" day works.
   */
  | { type: "multibuy"; buyQty: number; payQty: number; productDs?: string[] }
  /** Buy one of A, get one of B free. A === B is legal and equals a 2x1. */
  | { type: "buyXgetY"; buyProductD: string; giftProductD: string }

export const MAX_COUPON_NAME = 80
export const MAX_COUPON_DESCRIPTION = 500
export const MAX_COUPON_IMAGE_URL = 500
/** A cap high enough for any real promo and low enough to bound the arithmetic. */
export const MAX_MULTIBUY_QTY = 100
/** Products one coupon may name. Long enough for a category, short enough to render. */
export const MAX_COUPON_PRODUCTS = 50
/** Uses per definition. Guards against a typo'd "1e9" becoming a real column. */
export const MAX_COUPON_USES = 1_000_000

export type ParsedBenefit =
  | { ok: true; value: Benefit }
  | { ok: false; reason: string }

const bad = (reason: string): ParsedBenefit => ({ ok: false, reason })

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Product references are the `d` tags this app generates — always UUIDs. */
export function isProductD(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max
}

type ParsedScope = { ok: true; value: string[] | undefined } | { ok: false; reason: string }

/**
 * Read a product scope off an untrusted benefit.
 *
 * An empty list is normalised to `undefined` rather than kept: "applies to no
 * products" is a coupon that can never discount anything, and a merchant who
 * cleared the picker meant "all", not "none".
 *
 * `productD` (singular) is still accepted because minted coupons store their
 * benefit as a frozen snapshot — rows written before scopes were a list have to
 * keep parsing, or a customer's outstanding 2x1 would stop working.
 */
function parseScope(b: Record<string, unknown>): ParsedScope {
  const raw = b.productDs ?? (b.productD === undefined || b.productD === null ? undefined : [b.productD])
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return { ok: false, reason: "la lista de productos no es válida" }
  if (raw.length > MAX_COUPON_PRODUCTS) {
    return { ok: false, reason: `no más de ${MAX_COUPON_PRODUCTS} productos` }
  }
  const out: string[] = []
  for (const d of raw) {
    if (!isProductD(d)) return { ok: false, reason: "hay un producto que no es válido" }
    if (!out.includes(d)) out.push(d)
  }
  return { ok: true, value: out.length > 0 ? out : undefined }
}

/** Spread a scope into an object literal only when it exists. */
const withScope = (productDs: string[] | undefined) =>
  productDs ? { productDs } : {}

/**
 * Validate an untrusted benefit — a request body, or a jsonb column written by
 * an older version of this code.
 *
 * Returns a reason rather than throwing because both callers (an API route and
 * a form) need to say something specific to a human.
 */
export function parseBenefit(raw: unknown): ParsedBenefit {
  if (typeof raw !== "object" || raw === null) return bad("no es un objeto")
  const b = raw as Record<string, unknown>

  switch (b.type) {
    case "percent": {
      if (!isPositiveInt(b.percent, 100)) {
        return bad("el porcentaje tiene que ser un entero de 1 a 100")
      }
      const scope = parseScope(b)
      if (!scope.ok) return bad(scope.reason)
      return {
        ok: true,
        value: { type: "percent", percent: b.percent, ...withScope(scope.value) },
      }
    }

    case "fixed": {
      const { amount, currency } = b
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return bad("el monto tiene que ser mayor a 0")
      }
      if (typeof currency !== "string" || !isSupportedCurrency(currency)) {
        return bad(`la moneda tiene que ser ${CURRENCIES.join(", ")}`)
      }
      // Sub-sat amounts cannot be charged, and rounding them silently would
      // make the coupon worth something other than what it says.
      if (currency === "SAT" && !Number.isInteger(amount)) {
        return bad("en sats el monto tiene que ser entero")
      }
      const scope = parseScope(b)
      if (!scope.ok) return bad(scope.reason)
      return {
        ok: true,
        value: { type: "fixed", amount, currency, ...withScope(scope.value) },
      }
    }

    case "multibuy": {
      const { buyQty, payQty } = b
      if (!isPositiveInt(buyQty, MAX_MULTIBUY_QTY)) {
        return bad(`la cantidad a llevar tiene que ser un entero de 1 a ${MAX_MULTIBUY_QTY}`)
      }
      if (!isPositiveInt(payQty, MAX_MULTIBUY_QTY)) {
        return bad("la cantidad a pagar tiene que ser un entero mayor a 0")
      }
      // payQty === buyQty is a coupon that discounts nothing — accepting it
      // would let a merchant hand out something they think is a promo.
      if (payQty >= buyQty) {
        return bad("hay que pagar menos de lo que se lleva")
      }
      const scope = parseScope(b)
      if (!scope.ok) return bad(scope.reason)
      return {
        ok: true,
        value: { type: "multibuy", buyQty, payQty, ...withScope(scope.value) },
      }
    }

    case "buyXgetY": {
      const { buyProductD, giftProductD } = b
      if (!isProductD(buyProductD)) return bad("el producto a comprar no es válido")
      if (!isProductD(giftProductD)) return bad("el producto de regalo no es válido")
      return { ok: true, value: { type: "buyXgetY", buyProductD, giftProductD } }
    }

    default:
      return bad("tipo de cupón desconocido")
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Column mapping
// ───────────────────────────────────────────────────────────────────────────

/** The enum stored in Postgres. Snake case there, camel in the union. */
export type CouponTypeColumn = "percent" | "fixed" | "multibuy" | "buy_x_get_y"

export interface BenefitColumns {
  type: CouponTypeColumn
  percent: number | null
  amount: string | null
  currency: string | null
  buyQty: number | null
  payQty: number | null
  /** The scope, as stored. Null ⇒ every product. */
  productDs: string[] | null
  buyProductD: string | null
  giftProductD: string | null
}

const EMPTY_COLUMNS: Omit<BenefitColumns, "type"> = {
  percent: null,
  amount: null,
  currency: null,
  buyQty: null,
  payQty: null,
  productDs: null,
  buyProductD: null,
  giftProductD: null,
}

export function benefitToColumns(b: Benefit): BenefitColumns {
  switch (b.type) {
    case "percent":
      return {
        ...EMPTY_COLUMNS,
        type: "percent",
        percent: b.percent,
        productDs: b.productDs ?? null,
      }
    case "fixed":
      return {
        ...EMPTY_COLUMNS,
        type: "fixed",
        // numeric(14,2) round-trips as a string; sending one keeps the
        // driver from reformatting a float behind our back.
        amount: b.currency === "SAT" ? String(b.amount) : b.amount.toFixed(2),
        currency: b.currency,
        productDs: b.productDs ?? null,
      }
    case "multibuy":
      return {
        ...EMPTY_COLUMNS,
        type: "multibuy",
        buyQty: b.buyQty,
        payQty: b.payQty,
        productDs: b.productDs ?? null,
      }
    case "buyXgetY":
      return {
        ...EMPTY_COLUMNS,
        type: "buy_x_get_y",
        buyProductD: b.buyProductD,
        giftProductD: b.giftProductD,
      }
  }
}

/**
 * Rebuild a benefit from its columns.
 *
 * Goes back through `parseBenefit` rather than trusting the row: a hand-edited
 * database, or a column set left half-populated by an older migration, must
 * surface as an error and not as a coupon that discounts NaN.
 */
export function benefitFromColumns(row: Partial<BenefitColumns>): ParsedBenefit {
  switch (row.type) {
    case "percent":
      return parseBenefit({
        type: "percent",
        percent: row.percent,
        productDs: row.productDs ?? undefined,
      })
    case "fixed":
      return parseBenefit({
        type: "fixed",
        amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
        currency: row.currency,
        productDs: row.productDs ?? undefined,
      })
    case "multibuy":
      return parseBenefit({
        type: "multibuy",
        buyQty: row.buyQty,
        payQty: row.payQty,
        productDs: row.productDs ?? undefined,
      })
    case "buy_x_get_y":
      return parseBenefit({
        type: "buyXgetY",
        buyProductD: row.buyProductD,
        giftProductD: row.giftProductD,
      })
    default:
      return bad("tipo de cupón desconocido")
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Field validation shared by the API routes and the form
// ───────────────────────────────────────────────────────────────────────────

export function normalizeCouponName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const name = raw.trim()
  if (!name || name.length > MAX_COUPON_NAME) return null
  return name
}

export function normalizeCouponDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return ""
  if (typeof raw !== "string") return null
  const description = raw.trim()
  return description.length > MAX_COUPON_DESCRIPTION ? null : description
}

/**
 * A coupon image is rendered by POS clients we do not control, so the URL has
 * to be boring: https, no embedded credentials, a real hostname. Same
 * strictness as normalizeStoreUrl() in woo-config.ts, and for the same reason —
 * this string ends up in somebody else's `<img src>`.
 */
export function normalizeCouponImageUrl(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "string") return undefined
  const value = raw.trim()
  if (!value) return null
  if (value.length > MAX_COUPON_IMAGE_URL) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") return undefined
    if (url.username || url.password) return undefined
    if (!url.hostname.includes(".")) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** 16 random bytes, base64url. 128 bits is unguessable and fits in a QR. */
export const NONCE_LENGTH = 22
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/

export function isValidNonce(v: unknown): v is string {
  return typeof v === "string" && NONCE_RE.test(v)
}

// ───────────────────────────────────────────────────────────────────────────
// Human-readable summaries (es-AR)
// ───────────────────────────────────────────────────────────────────────────

/** Formats an amount the way the price tag does, without the currency label. */
function money(amount: number, currency: string): string {
  return currency === "SAT"
    ? `${Math.round(amount)} sat`
    : `${currency} ${Number(amount.toFixed(2))}`
}

/**
 * One line describing what the coupon does, for the list and the voucher.
 *
 * @param titleOf resolves a product `d` to its title. Falls back to a generic
 *   noun, because a coupon must still describe itself when it points at a
 *   product this client has not loaded — or one the merchant has since deleted.
 */
export function describeBenefit(
  b: Benefit,
  titleOf?: (d: string) => string | undefined
): string {
  const name = (d: string) => titleOf?.(d) ?? "un producto"
  /** "en X" for one product, "en N productos" for a list, "" for the store. */
  const scope = (ds: string[] | undefined) => {
    if (!ds || ds.length === 0) return ""
    return ds.length === 1 ? ` en ${name(ds[0]!)}` : ` en ${ds.length} productos`
  }
  switch (b.type) {
    case "percent":
      return `${b.percent}% de descuento${scope(b.productDs)}`
    case "fixed":
      return `${money(b.amount, b.currency)} de descuento${scope(b.productDs)}`
    case "multibuy":
      return b.productDs && b.productDs.length > 0
        ? `${b.buyQty}x${b.payQty}${scope(b.productDs)}`
        : `${b.buyQty}x${b.payQty} en cualquier producto`
    case "buyXgetY":
      return `Comprá ${name(b.buyProductD)} y llevate ${name(b.giftProductD)} gratis`
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pricing a cart with a coupon
// ───────────────────────────────────────────────────────────────────────────

/** A coupon the shopper has applied — the cart's copy of the mint response. */
export interface AppliedCoupon {
  nonce: string
  couponId: string
  name: string
  benefit: Benefit
  image?: string
  /** Set once the claim endpoint has consumed the nonce for this order. */
  claimedAt?: number
}

export interface DiscountEntry {
  currency: string
  amount: number
}

/** Units given away, by product `d` — for the "1 gratis" badge on a line. */
export interface FreeUnits {
  d: string
  qty: number
}

/**
 * Why a coupon is not discounting anything right now.
 *
 * `needs-products` carries what the cart is missing so the storefront can say
 * "agregá X" instead of "el cupón no aplica", which reads as a broken coupon.
 */
export type CouponUnmet =
  | { kind: "empty-cart" }
  | { kind: "unquotable"; currency: string }
  | {
      kind: "needs-products"
      products: FreeUnits[]
      /**
       * True when ANY ONE of `products` unlocks the coupon, false when all of
       * them are required.
       *
       * A percentage scoped to five products needs one of the five; a
       * buy-X-get-Y needs both sides. Telling a shopper to add five things when
       * one would do is a coupon they will give up on.
       */
      anyOf: boolean
    }

export interface PricedCart {
  /** What the basket costs with no coupon. */
  gross: Quote
  /** What the shopper pays. Identical to `gross` when nothing applies. */
  net: Quote
  /** Per-currency discount, for the "Cupón — ARS 500" row. */
  entries: DiscountEntry[]
  /** Fractional sats taken off, already clamped to the basket's value. */
  discountExactSats: number
  /** Whole sats taken off. Display only — the charge is `net.sats`. */
  discountSats: number
  freeUnits: FreeUnits[]
  /** Null when the coupon is discounting something. */
  unmet: CouponUnmet | null
}

/**
 * Never let a discount drive the invoice to zero.
 *
 * A zero-sat invoice is not payable — wallets reject it and LNURL servers
 * declare a `minSendable` of at least one sat. A 100%-off coupon therefore
 * leaves one satoshi on the bill, which is a rounding artefact at any real
 * price and infinitely better than a checkout that cannot produce an invoice.
 */
export const MIN_CHARGE_SATS = 1

function subtotalsByCurrency(lines: readonly CartLine[]): DiscountEntry[] {
  const out: DiscountEntry[] = []
  for (const l of lines) {
    const found = out.find((s) => s.currency === l.currency)
    if (found) found.amount += l.unitAmount * l.qty
    else out.push({ currency: l.currency, amount: l.unitAmount * l.qty })
  }
  return out
}

function roundMoney(amount: number, currency: string): number {
  return currency === "SAT" ? Math.round(amount) : Number(amount.toFixed(2))
}

/** The lines a scoped benefit may touch. No scope ⇒ the whole basket. */
function scopedLines(
  lines: readonly CartLine[],
  productDs: string[] | undefined
): readonly CartLine[] {
  if (!productDs || productDs.length === 0) return lines
  return lines.filter((l) => productDs.includes(l.d))
}

/**
 * How many units this coupon gives away, per line.
 *
 * A coupon is single-use, so buyXgetY grants exactly one gift — "buy one get
 * one free, unlimited" is a store-wide promo (multibuy without a productD),
 * not a coupon somebody redeems once.
 */
export function freeUnitsFor(
  lines: readonly CartLine[],
  benefit: Benefit
): FreeUnits[] {
  if (benefit.type === "multibuy") {
    return scopedLines(lines, benefit.productDs)
      .map((l) => ({
        d: l.d,
        qty: Math.floor(l.qty / benefit.buyQty) * (benefit.buyQty - benefit.payQty),
      }))
      .filter((f) => f.qty > 0)
  }

  if (benefit.type === "buyXgetY") {
    const buy = lines.find((l) => l.d === benefit.buyProductD)
    const gift = lines.find((l) => l.d === benefit.giftProductD)
    if (!buy || !gift) return []
    // Same product on both sides is a 2x1: the shopper needs two of it before
    // one can be free, otherwise the single unit they bought is the gift.
    const needed = benefit.buyProductD === benefit.giftProductD ? 2 : 1
    if (gift.qty < needed) return []
    return [{ d: gift.d, qty: 1 }]
  }

  return []
}

/** What the cart is still missing for a product-conditioned coupon to apply. */
function missingProducts(
  lines: readonly CartLine[],
  benefit: Benefit
): FreeUnits[] {
  if (benefit.type === "percent" || benefit.type === "fixed") {
    // Only reachable with a scope: an unscoped percentage always discounts a
    // non-empty cart. So the basket is missing every product the coupon names.
    if (!benefit.productDs) return []
    return benefit.productDs
      .filter((d) => !lines.some((l) => l.d === d))
      .map((d) => ({ d, qty: 1 }))
  }

  if (benefit.type === "multibuy") {
    if (!benefit.productDs || benefit.productDs.length === 0) {
      return [{ d: "", qty: benefit.buyQty }]
    }
    // Name the product they are CLOSEST to qualifying with — "agregá 1 más de
    // X" is actionable in a way that listing ten products they do not have is
    // not.
    const shortfalls = benefit.productDs.map((d) => ({
      d,
      qty: benefit.buyQty - (lines.find((l) => l.d === d)?.qty ?? 0),
    }))
    const best = shortfalls.reduce((a, b) => (b.qty < a.qty ? b : a))
    return [best]
  }
  if (benefit.type === "buyXgetY") {
    const out: FreeUnits[] = []
    const buy = lines.find((l) => l.d === benefit.buyProductD)
    const gift = lines.find((l) => l.d === benefit.giftProductD)
    const needed = benefit.buyProductD === benefit.giftProductD ? 2 : 1
    if (!buy) out.push({ d: benefit.buyProductD, qty: 1 })
    if ((gift?.qty ?? 0) < needed) {
      out.push({ d: benefit.giftProductD, qty: needed - (gift?.qty ?? 0) })
    }
    return out
  }
  return []
}

/** Per-currency value of what the coupon takes off, before any clamping. */
export function discountEntries(
  lines: readonly CartLine[],
  benefit: Benefit
): DiscountEntry[] {
  switch (benefit.type) {
    case "percent": {
      return subtotalsByCurrency(scopedLines(lines, benefit.productDs))
        .map((s) => ({
          currency: s.currency,
          amount: roundMoney((s.amount * benefit.percent) / 100, s.currency),
        }))
        .filter((s) => s.amount > 0)
    }

    case "fixed": {
      if (!benefit.productDs) {
        return [{ currency: benefit.currency, amount: benefit.amount }]
      }
      /**
       * Capped at what the named products are actually worth.
       *
       * "ARS 500 off coffee" against a basket holding ARS 200 of coffee and
       * ARS 5000 of everything else has to take off 200, not 500 — otherwise a
       * product-scoped coupon quietly discounts the rest of the cart.
       *
       * Only the coupon's own currency counts. A cross-currency cap would need
       * the rate table, which this function deliberately does not take; if the
       * named products are priced in something else, the coupon simply does not
       * apply and the caller reports it as such.
       */
      const eligible = subtotalsByCurrency(scopedLines(lines, benefit.productDs)).find(
        (s) => s.currency === benefit.currency
      )
      const amount = Math.min(benefit.amount, eligible?.amount ?? 0)
      return amount > 0 ? [{ currency: benefit.currency, amount }] : []
    }

    case "multibuy":
    case "buyXgetY": {
      const free = freeUnitsFor(lines, benefit)
      const out: DiscountEntry[] = []
      for (const f of free) {
        const line = lines.find((l) => l.d === f.d)
        if (!line) continue
        const value = line.unitAmount * f.qty
        const found = out.find((s) => s.currency === line.currency)
        if (found) found.amount += value
        else out.push({ currency: line.currency, amount: value })
      }
      return out
        .map((s) => ({ currency: s.currency, amount: roundMoney(s.amount, s.currency) }))
        .filter((s) => s.amount > 0)
    }
  }
}

/**
 * Price a cart, with or without a coupon.
 *
 * The discount is applied by SCALING every per-currency subtotal by the same
 * factor, then quoting once. Two things fall out of that:
 *
 *  - THE ONE RULE from rates.ts survives untouched. The ceiling still happens
 *    exactly once, over the discounted basket, so what is on screen adds up to
 *    what is on the invoice.
 *  - `net.perCurrency` stays internally consistent. Subtracting a fixed ARS
 *    coupon from the ARS row alone would leave the fiat breakdown adding up to
 *    something other than the sat total on a mixed-currency cart; scaling
 *    spreads it in proportion to what each currency actually contributes.
 *
 * For the overwhelmingly common single-currency cart, scaling IS exact
 * subtraction: ARS 1000 less 10% is the ARS 900 row.
 */
export function priceCart(
  lines: readonly CartLine[],
  coupon: AppliedCoupon | null,
  table: SatPriceTable
): PricedCart {
  const grossEntries = subtotalsByCurrency(lines)
  const gross = quote(grossEntries, table)

  const none = (unmet: CouponUnmet | null): PricedCart => ({
    gross,
    net: gross,
    entries: [],
    discountExactSats: 0,
    discountSats: 0,
    freeUnits: [],
    unmet,
  })

  if (!coupon) return none(null)
  if (lines.length === 0) return none({ kind: "empty-cart" })

  const entries = discountEntries(lines, coupon.benefit)
  if (entries.length === 0) {
    const products = missingProducts(lines, coupon.benefit)
    // Scoped percent/fixed coupons take whichever named product shows up;
    // multibuy and buyXgetY name what they specifically require.
    const anyOf = coupon.benefit.type === "percent" || coupon.benefit.type === "fixed"
    return none(
      products.length > 0
        ? { kind: "needs-products", products, anyOf }
        : { kind: "empty-cart" }
    )
  }

  // A discount we cannot convert is a discount we must not guess at: charging
  // the full price is wrong, and charging an invented number is worse.
  let discount = 0
  for (const e of entries) {
    const sats = toSats(e.amount, e.currency, table)
    if (sats === null) return none({ kind: "unquotable", currency: e.currency })
    discount += sats
  }

  // Leave MIN_CHARGE_SATS on the bill, and cap the discount at the basket's
  // own value so an over-generous coupon cannot produce a negative total.
  const spendable = Math.max(0, gross.exactSats - MIN_CHARGE_SATS)
  const discountExactSats = Math.min(discount, spendable)
  const scale =
    gross.exactSats > 0 ? (gross.exactSats - discountExactSats) / gross.exactSats : 0

  const net = quote(
    grossEntries.map((e) => ({ currency: e.currency, amount: e.amount * scale })),
    table
  )

  return {
    gross,
    net,
    entries,
    discountExactSats,
    discountSats: Math.round(discountExactSats),
    freeUnits: freeUnitsFor(lines, coupon.benefit),
    unmet: null,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The voucher: a coupon signed by this server's manager key
// ───────────────────────────────────────────────────────────────────────────

export type VoucherPhase = "minted" | "claimed"

/**
 * The voucher's payload — everything a POS needs to trust a coupon it was
 * handed, without calling us back.
 *
 * It exists because the mint and claim responses are plain JSON over HTTPS,
 * which proves the coupon came from whoever holds the TLS certificate. A
 * signature by the manager key proves it came from the service the MERCHANT
 * named in their discovery event, which is the thing a cashier actually needs.
 */
export interface VoucherPayload {
  v: 1
  nonce: string
  /** The coupon owner's pubkey, hex. */
  owner: string
  name: string
  description: string
  image?: string
  /** Named `coupon` to match the field name in the mint and claim responses. */
  coupon: Benefit
  phase: VoucherPhase
  /** Unix seconds, on a claimed voucher. */
  claimedAt?: number
  /** Unix seconds. Absent when the coupon never expires. */
  expiresAt?: number
}

export interface VoucherInput {
  nonce: string
  owner: string
  couponId: string
  name: string
  description: string
  image?: string | null
  benefit: Benefit
  phase: VoucherPhase
  claimedAt?: number | null
  expiresAt?: number | null
}

/**
 * The unsigned voucher. The caller stamps `created_at` and signs it — see
 * src/lib/server/coupon-manager.ts.
 *
 * Tags duplicate a few content fields so a client can filter and display
 * without parsing JSON; `content` is the canonical payload. The `expiration`
 * tag is NIP-40, so a relay that ever sees a leaked voucher drops it on time.
 */
export function voucherEventBody(input: VoucherInput): EventBody {
  const payload: VoucherPayload = {
    v: 1,
    nonce: input.nonce,
    owner: input.owner,
    name: input.name,
    description: input.description,
    coupon: input.benefit,
    phase: input.phase,
  }
  if (input.image) payload.image = input.image
  if (input.phase === "claimed" && input.claimedAt) payload.claimedAt = input.claimedAt
  if (input.expiresAt) payload.expiresAt = input.expiresAt

  const tags: string[][] = [
    ["nonce", input.nonce],
    ["p", input.owner],
    ["coupon", input.couponId],
    ["phase", input.phase],
  ]
  if (input.expiresAt) tags.push(["expiration", String(input.expiresAt)])

  return {
    kind: KINDS.COUPON_VOUCHER,
    content: JSON.stringify(payload),
    tags,
  }
}

/**
 * Read a voucher's content. The signature is the caller's job — verify it with
 * verifySignedEvent() and check the author against the manager pubkey from the
 * merchant's discovery event before believing any of this.
 */
export function parseVoucherContent(content: string): VoucherPayload | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return null
    const p = parsed as Partial<VoucherPayload>
    // Unknown versions are DISCARDED, never migrated — same rule as the cart.
    if (p.v !== 1) return null
    if (!isValidNonce(p.nonce)) return null
    if (typeof p.owner !== "string" || !/^[0-9a-f]{64}$/i.test(p.owner)) return null
    if (typeof p.name !== "string" || typeof p.description !== "string") return null
    if (p.phase !== "minted" && p.phase !== "claimed") return null
    const benefit = parseBenefit(p.coupon)
    if (!benefit.ok) return null

    const out: VoucherPayload = {
      v: 1,
      nonce: p.nonce,
      owner: p.owner.toLowerCase(),
      name: p.name,
      description: p.description,
      coupon: benefit.value,
      phase: p.phase,
    }
    if (typeof p.image === "string") out.image = p.image
    if (typeof p.claimedAt === "number") out.claimedAt = p.claimedAt
    if (typeof p.expiresAt === "number") out.expiresAt = p.expiresAt
    return out
  } catch {
    return null
  }
}
