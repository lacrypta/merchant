import { isValidNonce, parseBenefit, type AppliedCoupon } from "@/lib/domain/coupon"
import type { Product, Visibility } from "@/lib/domain/product"
import { quote, type Quote, type SatPriceTable } from "@/lib/domain/rates"

/**
 * The shopping cart — pure state transitions, no React, no storage.
 *
 * Every mutator returns a NEW cart. The provider is the only thing that knows
 * about localStorage or rendering.
 */

/**
 * The slice of a Product that crosses the server/client boundary.
 *
 * Deliberately narrow. A `Product` carries `description` (markdown),
 * `unknownTags` and the full image list; serialising all of that for every
 * tile would put tens of kilobytes of never-rendered payload into the RSC
 * stream on a 120-item catalog.
 */
export interface CartItem {
  d: string
  title: string
  thumbUrl?: string
  /** null ⇒ "Consultar precio" ⇒ can never be added. */
  price: { amount: number; currency: string } | null
  /** null ⇒ untracked, not zero. */
  stock: number | null
  visibility: Visibility
}

/** Keyed by `d`, for reconciling a stored cart against the live catalog. */
export type CatalogIndex = Readonly<Record<string, CartItem>>

/**
 * A line denormalises title and price on purpose: the cart has to keep
 * naming what the customer chose even after the product is edited, delisted
 * or deleted out from under them.
 */
export interface CartLine {
  d: string
  qty: number
  title: string
  unitAmount: number
  currency: string
  thumbUrl?: string
  preOrder?: boolean
}

export interface Cart {
  v: 1
  lines: CartLine[]
  updatedAt: number
  /**
   * A coupon the shopper applied. Undefined is the normal case.
   *
   * Lives in the cart rather than in checkout-local state because the discount
   * has to be visible while they are still shopping — a 2x1 that only appears
   * after they hit "Pagar" is a coupon they never knew to use. It also survives
   * the reload that a QR scan on a phone routinely causes.
   *
   * Note this does NOT bump the cart version: the field is additive, and a cart
   * stored by an older build parses fine without it.
   */
  coupon?: AppliedCoupon
}

export const CART_VERSION = 1 as const
/** Per merchant: one origin serves every storefront. */
export const cartKey = (merchantPubkey: string) => `mm:cart:${merchantPubkey}`

/** A cart older than this is dropped — its prices are fiction by then. */
export const CART_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export function emptyCart(now: number): Cart {
  return { v: CART_VERSION, lines: [], updatedAt: now }
}

export function toCartItem(p: Product): CartItem {
  const thumb = p.images.find((i) => i.width === 256) ?? p.images[0]
  return {
    d: p.d,
    title: p.title,
    thumbUrl: thumb?.url,
    price: p.price ? { amount: p.price.amount, currency: p.price.currency } : null,
    stock: p.stock,
    visibility: p.visibility,
  }
}

/** Untracked stock (null) is unlimited; tracked stock is a hard ceiling. */
export function maxQty(item: Pick<CartItem, "stock">): number {
  return item.stock === null ? Number.POSITIVE_INFINITY : Math.max(0, item.stock)
}

export function isAddable(item: CartItem): boolean {
  return item.price !== null && maxQty(item) > 0
}

export function lineFor(cart: Cart, d: string): CartLine | undefined {
  return cart.lines.find((l) => l.d === d)
}

export function qtyOf(cart: Cart, d: string): number {
  return lineFor(cart, d)?.qty ?? 0
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.qty, 0)
}

/**
 * Add (or top up) a line.
 *
 * An unpriced product is silently refused rather than added at zero: a line
 * with no price makes the total quietly wrong, and a wrong total at a till is
 * the worst failure this app can produce. The UI never offers the control in
 * the first place — this is the backstop.
 */
export function addToCart(
  cart: Cart,
  item: CartItem,
  now: number,
  delta = 1
): Cart {
  if (!isAddable(item) || !item.price) return cart

  const cap = maxQty(item)
  const existing = lineFor(cart, item.d)
  const next = Math.min(cap, (existing?.qty ?? 0) + delta)
  if (next <= 0) return removeLine(cart, item.d, now)
  if (existing && existing.qty === next) return cart

  const line: CartLine = {
    d: item.d,
    qty: next,
    title: item.title,
    unitAmount: item.price.amount,
    currency: item.price.currency,
    thumbUrl: item.thumbUrl,
    preOrder: item.visibility === "pre-order" ? true : undefined,
  }

  return {
    ...cart,
    updatedAt: now,
    lines: existing
      ? cart.lines.map((l) => (l.d === item.d ? line : l))
      : [...cart.lines, line],
  }
}

/**
 * Set an existing line's quantity outright.
 *
 * Does NOT clamp to stock — it has no catalog to clamp against. Increments
 * go through addToCart(), which does; reconcile() catches anything that slips
 * past. This exists for the stepper's decrement and for a direct edit.
 */
export function setQty(cart: Cart, d: string, qty: number, now: number): Cart {
  if (qty <= 0) return removeLine(cart, d, now)
  const existing = lineFor(cart, d)
  if (!existing || existing.qty === qty) return cart
  return {
    ...cart,
    updatedAt: now,
    lines: cart.lines.map((l) => (l.d === d ? { ...l, qty } : l)),
  }
}

export function removeLine(cart: Cart, d: string, now: number): Cart {
  if (!lineFor(cart, d)) return cart
  return { ...cart, updatedAt: now, lines: cart.lines.filter((l) => l.d !== d) }
}

export function applyCoupon(cart: Cart, coupon: AppliedCoupon, now: number): Cart {
  return { ...cart, updatedAt: now, coupon }
}

export function removeCoupon(cart: Cart, now: number): Cart {
  if (!cart.coupon) return cart
  // Rebuilt rather than spread-and-delete so `coupon` is genuinely absent, not
  // present-and-undefined — JSON.stringify keeps the difference.
  return { v: cart.v, lines: cart.lines, updatedAt: now }
}

export type LineIssue =
  | { d: string; kind: "gone" }
  | { d: string; kind: "sold-out" }
  | { d: string; kind: "stock-clamped"; from: number; to: number }
  | {
      d: string
      kind: "price-changed"
      was: { amount: number; currency: string }
      now: { amount: number; currency: string }
    }

/**
 * Reconcile a stored cart against the catalog we just loaded.
 *
 * Stock is clamped automatically — there is nothing for the customer to
 * decide, and letting them walk to checkout with 5 of something that has 2
 * left only moves the disappointment later. Price changes and disappearances
 * are REPORTED, not applied: silently re-pricing someone's cart upward while
 * they aren't looking is exactly the thing that destroys trust in a store.
 */
export function reconcile(
  cart: Cart,
  index: CatalogIndex,
  now: number
): { cart: Cart; issues: LineIssue[] } {
  const issues: LineIssue[] = []
  const lines: CartLine[] = []
  let changed = false

  for (const line of cart.lines) {
    const item = index[line.d]

    if (!item || !item.price) {
      issues.push({ d: line.d, kind: "gone" })
      changed = true
      continue // drop it; the banner names it from the issue, not the line
    }

    const cap = maxQty(item)
    if (cap <= 0) {
      issues.push({ d: line.d, kind: "sold-out" })
      changed = true
      continue
    }

    if (
      item.price.amount !== line.unitAmount ||
      item.price.currency !== line.currency
    ) {
      issues.push({
        d: line.d,
        kind: "price-changed",
        was: { amount: line.unitAmount, currency: line.currency },
        now: { amount: item.price.amount, currency: item.price.currency },
      })
    }

    if (line.qty > cap) {
      issues.push({ d: line.d, kind: "stock-clamped", from: line.qty, to: cap })
      lines.push({ ...line, qty: cap })
      changed = true
      continue
    }

    lines.push(line)
  }

  return {
    cart: changed ? { ...cart, lines, updatedAt: now } : cart,
    issues,
  }
}

/** Accept the new prices for every line the catalog moved. */
export function acceptPrices(cart: Cart, index: CatalogIndex, now: number): Cart {
  return {
    ...cart,
    updatedAt: now,
    lines: cart.lines.map((l) => {
      const p = index[l.d]?.price
      return p ? { ...l, unitAmount: p.amount, currency: p.currency } : l
    }),
  }
}

/** Price the cart in sats. Rounding lives in rates.quote(), never here. */
export function cartQuote(cart: Cart, table: SatPriceTable): Quote {
  return quote(
    cart.lines.map((l) => ({ amount: l.unitAmount * l.qty, currency: l.currency })),
    table
  )
}

/** Subtotals per currency, in the order the lines were added. Display only. */
export function subtotalsByCurrency(cart: Cart): { currency: string; amount: number }[] {
  const out: { currency: string; amount: number }[] = []
  for (const l of cart.lines) {
    const found = out.find((s) => s.currency === l.currency)
    if (found) found.amount += l.unitAmount * l.qty
    else out.push({ currency: l.currency, amount: l.unitAmount * l.qty })
  }
  return out
}

/**
 * Parse a cart out of localStorage.
 *
 * Anything unexpected returns null so the caller starts clean. There is no
 * migration path and there should not be one: a cart is worth cents of
 * convenience, and a half-migrated cart that misprices a line is worth far
 * less than an empty one.
 */
export function parseCart(raw: string | null, now: number): Cart | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null

    const c = parsed as Partial<Cart>
    if (c.v !== CART_VERSION || !Array.isArray(c.lines)) return null
    if (typeof c.updatedAt !== "number" || now - c.updatedAt > CART_MAX_AGE_MS) {
      return null
    }

    const lines = c.lines.filter(isCartLine)
    if (lines.length !== c.lines.length) return null

    // A bad coupon drops the COUPON, not the cart: the lines are still exactly
    // what the shopper chose, and throwing them away to punish a malformed
    // discount would be the more expensive mistake. The server re-checks the
    // nonce before anything is charged anyway.
    const coupon = parseAppliedCoupon(c.coupon)

    return {
      v: CART_VERSION,
      lines,
      updatedAt: c.updatedAt,
      ...(coupon ? { coupon } : {}),
    }
  } catch {
    return null
  }
}

function parseAppliedCoupon(value: unknown): AppliedCoupon | null {
  if (typeof value !== "object" || value === null) return null
  const c = value as Partial<AppliedCoupon>
  if (!isValidNonce(c.nonce)) return null
  if (typeof c.couponId !== "string" || !c.couponId) return null
  if (typeof c.name !== "string") return null

  const benefit = parseBenefit(c.benefit)
  if (!benefit.ok) return null

  return {
    nonce: c.nonce,
    couponId: c.couponId,
    name: c.name,
    benefit: benefit.value,
    ...(typeof c.image === "string" ? { image: c.image } : {}),
    ...(typeof c.claimedAt === "number" ? { claimedAt: c.claimedAt } : {}),
  }
}

function isCartLine(v: unknown): v is CartLine {
  if (typeof v !== "object" || v === null) return false
  const l = v as Partial<CartLine>
  return (
    typeof l.d === "string" &&
    l.d.length > 0 &&
    typeof l.qty === "number" &&
    Number.isInteger(l.qty) &&
    l.qty > 0 &&
    typeof l.title === "string" &&
    typeof l.unitAmount === "number" &&
    Number.isFinite(l.unitAmount) &&
    l.unitAmount >= 0 &&
    typeof l.currency === "string" &&
    l.currency.length > 0
  )
}
