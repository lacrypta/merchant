import { describe, expect, it } from "vitest"

import { addToCart, emptyCart, parseCart, type CartItem, type CartLine } from "@/lib/domain/cart"
import type { SatPriceTable } from "@/lib/domain/rates"
import type { SignedEvent } from "@/lib/nostr/types"

import { parseProductCouponTag, priceCart, productCouponTag, type ProductCoupon } from "./coupon"
import { parseProductEvent, productEventBody } from "./product"

/** The Vaso: free, 5% off two drinks, at most one per order. */
const FERNET = "11111111-1111-4111-8111-111111111111"
const GIN = "22222222-2222-4222-8222-222222222222"
const PAPAS = "33333333-3333-4333-8333-333333333333"
const VASO_D = "44444444-4444-4444-8444-444444444444"
const VASO: ProductCoupon = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Vaso",
  benefit: { type: "percent", percent: 5, productDs: [FERNET, GIN] },
}
const TABLE: SatPriceTable = { SAT: 1, ARS: 1, USD: 0.001 }

const line = (d: string, unitAmount: number, qty = 1, coupon?: ProductCoupon): CartLine => ({
  d,
  qty,
  title: d,
  unitAmount,
  currency: "ARS",
  ...(coupon ? { coupon } : {}),
})

describe("coupon product event", () => {
  it("round-trips the coupon and max_qty tags", () => {
    const tags = productEventBody(
      {
        d: VASO_D,
        posId: 1,
        status: "active",
        title: "Vaso",
        description: "",
        price: { amount: 0, currency: "ARS" },
        stock: null,
        visibility: "on-sale",
        type: { kind: "simple", format: "physical" },
        categories: [],
        images: [],
        publishedAt: 1,
        updatedAt: 1,
        eventId: "e".repeat(64),
        pubkey: "a".repeat(64),
        unknownTags: [],
        coupon: VASO,
        maxQty: 1,
      },
      new Map(),
      1
    ).tags
    const parsed = parseProductEvent({
      id: "e".repeat(64),
      pubkey: "a".repeat(64),
      created_at: 1,
      kind: 30402,
      tags,
      content: "",
      sig: "s".repeat(128),
    } satisfies SignedEvent)

    expect(parsed.ok && parsed.value.coupon).toEqual(VASO)
    expect(parsed.ok && parsed.value.maxQty).toBe(1)
    expect(parsed.ok && parsed.value.price).toEqual({ amount: 0, currency: "ARS" })
    // Known tags: they must not ALSO round-trip through unknownTags.
    expect(parsed.ok && parsed.value.unknownTags).toEqual([])
  })

  it("drops terms it cannot read instead of guessing", () => {
    expect(parseProductCouponTag(["coupon", VASO.id, "Vaso", "{not json"])).toBeNull()
    expect(parseProductCouponTag(["coupon", VASO.id, "Vaso", '{"type":"percent","percent":500}'])).toBeNull()
    expect(parseProductCouponTag(["coupon", "nope", "Vaso", JSON.stringify(VASO.benefit)])).toBeNull()
    expect(parseProductCouponTag(productCouponTag(VASO))).toEqual(VASO)
  })
})

describe("priceCart with a coupon product", () => {
  it("takes 5% off the named drinks only, once however many Vasos", () => {
    const lines = [line(FERNET, 1000, 2), line(PAPAS, 1000), line(VASO_D, 0, 2, VASO)]
    const priced = priceCart(lines, null, TABLE)
    expect(priced.entries).toEqual([{ currency: "ARS", amount: 100 }])
    expect(priced.net.sats).toBe(2900)
    expect(priced.productCoupons).toEqual([VASO])
    expect(priced.unmet).toBeNull()
  })

  it("contributes nothing, and complains about nothing, without drinks", () => {
    const priced = priceCart([line(PAPAS, 1000), line(VASO_D, 0, 1, VASO)], null, TABLE)
    expect(priced.discountSats).toBe(0)
    expect(priced.productCoupons).toEqual([])
    expect(priced.unmet).toBeNull()
  })

  it("stacks with a typed coupon and still clamps to the basket", () => {
    const typed = {
      nonce: "hcLPDzERvvHzS4Vn0OLbAQ",
      couponId: "66666666-6666-4666-8666-666666666666",
      name: "Promo",
      benefit: { type: "fixed" as const, amount: 5000, currency: "ARS" as const },
    }
    const lines = [line(FERNET, 1000), line(VASO_D, 0, 1, VASO)]
    // 5% (50) + ARS 5000 on a ARS 1000 basket: the bill floors at zero.
    const priced = priceCart(lines, typed, TABLE)
    expect(priced.entries).toEqual([{ currency: "ARS", amount: 5050 }])
    expect(priced.net.sats).toBe(0)
    expect(priced.discountSats).toBe(1000)
  })
})

describe("cart limits", () => {
  const vaso: CartItem = {
    d: VASO_D,
    title: "Vaso",
    price: { amount: 0, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    coupon: VASO,
    maxQty: 1,
  }

  it("stops at max_qty and keeps the coupon on the line", () => {
    const cart = addToCart(addToCart(emptyCart(0), vaso, 0), vaso, 0)
    expect(cart.lines).toEqual([expect.objectContaining({ d: VASO_D, qty: 1, coupon: VASO })])
  })

  it("survives localStorage, and a tampered coupon comes off the line only", () => {
    const cart = addToCart(emptyCart(0), vaso, 0)
    expect(parseCart(JSON.stringify(cart), 0)?.lines[0]?.coupon).toEqual(VASO)

    const bad = { ...cart, lines: [{ ...cart.lines[0], coupon: { ...VASO, benefit: { type: "percent", percent: 900 } } }] }
    const back = parseCart(JSON.stringify(bad), 0)
    expect(back?.lines).toHaveLength(1)
    expect(back?.lines[0]?.coupon).toBeUndefined()
  })
})
