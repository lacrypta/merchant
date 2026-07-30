import { describe, expect, it } from "vitest"

import {
  CART_MAX_AGE_MS,
  addToCart,
  applyCoupon,
  cartCount,
  cartQuote,
  emptyCart,
  isAddable,
  parseCart,
  qtyOf,
  reconcile,
  removeCoupon,
  removeLine,
  setQty,
  subtotalsByCurrency,
  type CartItem,
  type CatalogIndex,
} from "./cart"
import { satPriceFromUnitsPerBtc } from "./rates"

const NOW = 1_785_000_000_000
const T = satPriceFromUnitsPerBtc({ ARS: 103_657_091.58, USD: 65_017.49 })

function item(over: Partial<CartItem> = {}): CartItem {
  return {
    d: "fernet",
    title: "Fernet con Coca",
    price: { amount: 7300, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    ...over,
  }
}

describe("addToCart", () => {
  it("adds a line and then tops it up", () => {
    let cart = addToCart(emptyCart(NOW), item(), NOW)
    cart = addToCart(cart, item(), NOW, 2)
    expect(cart.lines).toHaveLength(1)
    expect(qtyOf(cart, "fernet")).toBe(3)
    expect(cartCount(cart)).toBe(3)
  })

  it("refuses an unpriced product", () => {
    // The backstop for "Consultar precio": a zero-priced line would make the
    // total silently wrong, which at a till is the worst possible failure.
    const cart = addToCart(emptyCart(NOW), item({ price: null }), NOW)
    expect(cart.lines).toEqual([])
  })

  it("treats null stock as unlimited and a number as a hard ceiling", () => {
    expect(isAddable(item({ stock: null }))).toBe(true)
    expect(isAddable(item({ stock: 0 }))).toBe(false)

    const capped = addToCart(emptyCart(NOW), item({ stock: 2 }), NOW, 99)
    expect(qtyOf(capped, "fernet")).toBe(2)
  })

  it("does not confuse zero stock with untracked stock", () => {
    const cart = addToCart(emptyCart(NOW), item({ stock: 0 }), NOW)
    expect(cart.lines).toEqual([])
  })

  it("carries the pre-order flag through to the line", () => {
    const cart = addToCart(emptyCart(NOW), item({ visibility: "pre-order" }), NOW)
    expect(cart.lines[0]!.preOrder).toBe(true)
  })

  it("returns the same object when nothing changed, so React can bail out", () => {
    const cart = addToCart(emptyCart(NOW), item({ stock: 1 }), NOW)
    expect(addToCart(cart, item({ stock: 1 }), NOW)).toBe(cart)
  })

  it("removes the line when a decrement takes it to zero", () => {
    const cart = addToCart(emptyCart(NOW), item(), NOW)
    expect(addToCart(cart, item(), NOW, -1).lines).toEqual([])
  })
})

describe("setQty / removeLine", () => {
  it("removes at zero or below", () => {
    const cart = addToCart(emptyCart(NOW), item(), NOW, 3)
    expect(setQty(cart, "fernet", 0, NOW).lines).toEqual([])
    expect(setQty(cart, "fernet", -4, NOW).lines).toEqual([])
  })

  it("is a no-op for an unknown line", () => {
    const cart = emptyCart(NOW)
    expect(setQty(cart, "nope", 3, NOW)).toBe(cart)
    expect(removeLine(cart, "nope", NOW)).toBe(cart)
  })
})

describe("reconcile", () => {
  const index: CatalogIndex = { fernet: item({ stock: 2 }) }

  it("drops a product that vanished from the catalog and says so", () => {
    const cart = addToCart(emptyCart(NOW), item({ d: "ghost" }), NOW)
    const r = reconcile(cart, {}, NOW)
    expect(r.cart.lines).toEqual([])
    expect(r.issues).toEqual([{ d: "ghost", kind: "gone" }])
  })

  it("drops a product that sold out", () => {
    const cart = addToCart(emptyCart(NOW), item(), NOW)
    const r = reconcile(cart, { fernet: item({ stock: 0 }) }, NOW)
    expect(r.issues).toEqual([{ d: "fernet", kind: "sold-out" }])
    expect(r.cart.lines).toEqual([])
  })

  it("clamps quantity to stock automatically", () => {
    const cart = addToCart(emptyCart(NOW), item({ stock: null }), NOW, 5)
    const r = reconcile(cart, index, NOW)
    expect(qtyOf(r.cart, "fernet")).toBe(2)
    expect(r.issues).toEqual([{ d: "fernet", kind: "stock-clamped", from: 5, to: 2 }])
  })

  it("REPORTS a price change without applying it", () => {
    // Silently re-pricing a cart upward while the customer isn't looking is
    // the single fastest way to lose their trust.
    const cart = addToCart(emptyCart(NOW), item(), NOW)
    const r = reconcile(cart, { fernet: item({ price: { amount: 9000, currency: "ARS" } }) }, NOW)
    expect(r.cart.lines[0]!.unitAmount).toBe(7300)
    expect(r.issues).toEqual([
      {
        d: "fernet",
        kind: "price-changed",
        was: { amount: 7300, currency: "ARS" },
        now: { amount: 9000, currency: "ARS" },
      },
    ])
  })

  it("notices a currency switch even at the same number", () => {
    const cart = addToCart(emptyCart(NOW), item(), NOW)
    const r = reconcile(cart, { fernet: item({ price: { amount: 7300, currency: "USD" } }) }, NOW)
    expect(r.issues[0]).toMatchObject({ kind: "price-changed" })
  })

  it("returns the identical cart when nothing drifted", () => {
    const cart = addToCart(emptyCart(NOW), item({ stock: 2 }), NOW)
    const r = reconcile(cart, index, NOW)
    expect(r.cart).toBe(cart)
    expect(r.issues).toEqual([])
  })
})

describe("cartQuote", () => {
  it("multiplies by quantity and rounds the total once", () => {
    let cart = addToCart(emptyCart(NOW), item(), NOW, 2) // 14 600 ARS
    cart = addToCart(cart, item({ d: "empanada", price: { amount: 3, currency: "USD" } }), NOW)
    const q = cartQuote(cart, T)
    expect(q.sats).toBe(Math.ceil(14_600 / T.ARS + 3 / T.USD))
  })

  it("flags an exotic currency and still prices the rest", () => {
    let cart = addToCart(emptyCart(NOW), item(), NOW)
    cart = addToCart(cart, item({ d: "nft", price: { amount: 5, currency: "USDC" } }), NOW)
    const q = cartQuote(cart, T)
    expect(q.unquotable).toEqual(["USDC"])
    expect(q.sats).toBe(Math.ceil(7300 / T.ARS))
  })
})

describe("subtotalsByCurrency", () => {
  it("groups in first-seen order", () => {
    let cart = addToCart(emptyCart(NOW), item(), NOW, 2)
    cart = addToCart(cart, item({ d: "x", price: { amount: 3, currency: "USD" } }), NOW)
    cart = addToCart(cart, item({ d: "y", price: { amount: 700, currency: "ARS" } }), NOW)
    expect(subtotalsByCurrency(cart)).toEqual([
      { currency: "ARS", amount: 15_300 },
      { currency: "USD", amount: 3 },
    ])
  })
})

describe("parseCart", () => {
  const good = JSON.stringify(
    addToCart(emptyCart(NOW), item(), NOW)
  )

  it("round-trips a cart it wrote", () => {
    expect(parseCart(good, NOW)?.lines).toHaveLength(1)
  })

  it("drops anything that is not exactly version 1 — no migrations", () => {
    // A half-migrated cart that misprices a line is worth far less than an
    // empty one.
    expect(parseCart(JSON.stringify({ v: 2, lines: [], updatedAt: NOW }), NOW)).toBeNull()
    expect(parseCart(JSON.stringify({ lines: [], updatedAt: NOW }), NOW)).toBeNull()
  })

  it("drops a cart older than a week", () => {
    expect(parseCart(good, NOW + CART_MAX_AGE_MS + 1)).toBeNull()
    expect(parseCart(good, NOW + CART_MAX_AGE_MS - 1)).not.toBeNull()
  })

  it("rejects malformed or hostile lines wholesale", () => {
    const bad = [
      null,
      "",
      "{",
      "[]",
      JSON.stringify({ v: 1, updatedAt: NOW, lines: [{ d: "x", qty: 0, title: "", unitAmount: 1, currency: "ARS" }] }),
      JSON.stringify({ v: 1, updatedAt: NOW, lines: [{ d: "x", qty: 1.5, title: "", unitAmount: 1, currency: "ARS" }] }),
      JSON.stringify({ v: 1, updatedAt: NOW, lines: [{ d: "x", qty: 1, title: "", unitAmount: -1, currency: "ARS" }] }),
      JSON.stringify({ v: 1, updatedAt: NOW, lines: [{ d: "x", qty: 1, title: "", unitAmount: 1, currency: "" }] }),
      JSON.stringify({ v: 1, updatedAt: NOW, lines: [{ qty: 1, title: "", unitAmount: 1, currency: "ARS" }] }),
    ]
    for (const raw of bad) expect(parseCart(raw, NOW), String(raw).slice(0, 40)).toBeNull()
  })
})

describe("coupon on the cart", () => {
  const coupon = {
    nonce: "hcLPDzERvvHzS4Vn0OLbAQ",
    couponId: "33333333-3333-4333-8333-333333333333",
    name: "Promo",
    benefit: { type: "percent", percent: 10 } as const,
  }

  it("applies and removes without touching the lines", () => {
    const withLine = addToCart(emptyCart(NOW), item(), NOW)
    const withCoupon = applyCoupon(withLine, coupon, NOW + 1)
    expect(withCoupon.coupon).toEqual(coupon)
    expect(withCoupon.lines).toEqual(withLine.lines)

    const without = removeCoupon(withCoupon, NOW + 2)
    expect(without.lines).toEqual(withLine.lines)
    // Genuinely absent, not present-and-undefined: JSON.stringify keeps the
    // difference and localStorage is JSON.
    expect("coupon" in without).toBe(false)
  })

  it("round-trips through storage", () => {
    const raw = JSON.stringify(applyCoupon(addToCart(emptyCart(NOW), item(), NOW), coupon, NOW))
    expect(parseCart(raw, NOW)?.coupon).toEqual(coupon)
  })

  it("drops a MALFORMED coupon but keeps the cart", () => {
    // The lines are still exactly what the shopper chose; throwing them away to
    // punish a bad discount would be the more expensive mistake.
    const cases = [
      { ...coupon, nonce: "too-short" },
      { ...coupon, benefit: { type: "percent", percent: 900 } },
      { ...coupon, benefit: { type: "nonsense" } },
      { ...coupon, couponId: "" },
      "not an object",
    ]
    for (const bad of cases) {
      const raw = JSON.stringify({
        ...addToCart(emptyCart(NOW), item(), NOW),
        coupon: bad,
      })
      const parsed = parseCart(raw, NOW)
      expect(parsed?.lines, JSON.stringify(bad).slice(0, 40)).toHaveLength(1)
      expect(parsed?.coupon).toBeUndefined()
    }
  })
})
