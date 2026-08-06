import { describe, expect, it } from "vitest"

import type { CartLine } from "@/lib/domain/cart"
import type { SatPriceTable } from "@/lib/domain/rates"
import {
  MIN_CHARGE_SATS,
  benefitFromColumns,
  benefitToColumns,
  describeBenefit,
  discountByLine,
  discountEntries,
  freeUnitsFor,
  isValidNonce,
  normalizeCouponImageUrl,
  normalizeCouponName,
  parseBenefit,
  parseVoucherContent,
  priceCart,
  voucherEventBody,
  type AppliedCoupon,
  type Benefit,
} from "./coupon"

const D1 = "11111111-1111-4111-8111-111111111111"
const D2 = "22222222-2222-4222-8222-222222222222"
const D3 = "33333333-3333-4333-8333-333333333333"

/** 1 sat = 1 ARS, 1 sat = 0.001 USD — round numbers keep the assertions honest. */
const TABLE: SatPriceTable = { SAT: 1, ARS: 1, USD: 0.001 }

const line = (over: Partial<CartLine> = {}): CartLine => ({
  d: D1,
  qty: 1,
  title: "Empanada",
  unitAmount: 100,
  currency: "ARS",
  ...over,
})

const applied = (benefit: Benefit): AppliedCoupon => ({
  nonce: "hcLPDzERvvHzS4Vn0OLbAQ",
  couponId: "33333333-3333-4333-8333-333333333333",
  name: "Promo",
  benefit,
})

describe("parseBenefit", () => {
  it("accepts one of each type", () => {
    expect(parseBenefit({ type: "percent", percent: 10 }).ok).toBe(true)
    expect(parseBenefit({ type: "fixed", amount: 500.5, currency: "ARS" }).ok).toBe(true)
    expect(parseBenefit({ type: "multibuy", buyQty: 2, payQty: 1 }).ok).toBe(true)
    expect(
      parseBenefit({ type: "buyXgetY", buyProductD: D1, giftProductD: D2 }).ok
    ).toBe(true)
  })

  it("rejects percentages outside 1..100 and non-integers", () => {
    expect(parseBenefit({ type: "percent", percent: 0 }).ok).toBe(false)
    expect(parseBenefit({ type: "percent", percent: 101 }).ok).toBe(false)
    expect(parseBenefit({ type: "percent", percent: 10.5 }).ok).toBe(false)
  })

  it("rejects a fixed amount that is not positive, or an unsupported currency", () => {
    expect(parseBenefit({ type: "fixed", amount: 0, currency: "ARS" }).ok).toBe(false)
    expect(parseBenefit({ type: "fixed", amount: -5, currency: "ARS" }).ok).toBe(false)
    expect(parseBenefit({ type: "fixed", amount: 5, currency: "EUR" }).ok).toBe(false)
  })

  it("refuses fractional sats — they cannot be charged", () => {
    expect(parseBenefit({ type: "fixed", amount: 10.5, currency: "SAT" }).ok).toBe(false)
    expect(parseBenefit({ type: "fixed", amount: 10, currency: "SAT" }).ok).toBe(true)
  })

  it("refuses a multibuy that discounts nothing", () => {
    expect(parseBenefit({ type: "multibuy", buyQty: 2, payQty: 2 }).ok).toBe(false)
    expect(parseBenefit({ type: "multibuy", buyQty: 2, payQty: 3 }).ok).toBe(false)
  })

  it("requires product references to be UUIDs", () => {
    expect(parseBenefit({ type: "multibuy", buyQty: 2, payQty: 1, productD: "x" }).ok).toBe(
      false
    )
    expect(
      parseBenefit({ type: "buyXgetY", buyProductD: D1, giftProductD: "nope" }).ok
    ).toBe(false)
  })

  it("allows the same product on both sides of buyXgetY — that is a 2x1", () => {
    expect(
      parseBenefit({ type: "buyXgetY", buyProductD: D1, giftProductD: D1 }).ok
    ).toBe(true)
  })

  it("takes free items with their quantities", () => {
    expect(
      parseBenefit({ type: "freeItems", items: [{ d: D1, qty: 2 }, { d: D2, qty: 1 }] }).ok
    ).toBe(true)
  })

  it("refuses free items that are empty, repeated, or not a whole quantity", () => {
    // Empty would be "the whole catalog, free" — the absent-means-all rule that
    // governs productDs must not reach this type.
    expect(parseBenefit({ type: "freeItems", items: [] }).ok).toBe(false)
    expect(
      parseBenefit({ type: "freeItems", items: [{ d: D1, qty: 1 }, { d: D1, qty: 2 }] }).ok
    ).toBe(false)
    expect(parseBenefit({ type: "freeItems", items: [{ d: D1, qty: 0 }] }).ok).toBe(false)
    expect(parseBenefit({ type: "freeItems", items: [{ d: D1, qty: 1.5 }] }).ok).toBe(false)
    expect(parseBenefit({ type: "freeItems", items: [{ d: "nope", qty: 1 }] }).ok).toBe(false)
    expect(parseBenefit({ type: "freeItems", items: [{ d: D1 }] }).ok).toBe(false)
    expect(parseBenefit({ type: "freeItems", items: "todo" }).ok).toBe(false)
  })

  it("rejects unknown types and non-objects", () => {
    expect(parseBenefit({ type: "bogo" }).ok).toBe(false)
    expect(parseBenefit(null).ok).toBe(false)
    expect(parseBenefit("percent").ok).toBe(false)
  })
})

describe("column round-trip", () => {
  const cases: Benefit[] = [
    { type: "percent", percent: 25 },
    { type: "fixed", amount: 10.5, currency: "ARS" },
    { type: "fixed", amount: 1500, currency: "SAT" },
    { type: "multibuy", buyQty: 3, payQty: 2 },
    { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] },
    { type: "buyXgetY", buyProductD: D1, giftProductD: D2 },
    { type: "freeItems", items: [{ d: D1, qty: 2 }] },
    { type: "freeItems", items: [{ d: D1, qty: 1 }, { d: D2, qty: 3 }] },
  ]

  for (const benefit of cases) {
    it(`survives ${benefit.type} ${JSON.stringify(benefit)}`, () => {
      const back = benefitFromColumns(benefitToColumns(benefit))
      expect(back.ok).toBe(true)
      if (back.ok) expect(back.value).toEqual(benefit)
    })
  }

  it("parses the string pg hands back for numeric columns", () => {
    const back = benefitFromColumns({ type: "fixed", amount: "10.50", currency: "ARS" })
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.value).toEqual({ type: "fixed", amount: 10.5, currency: "ARS" })
  })

  it("treats a half-populated row as an error, not as a coupon worth NaN", () => {
    expect(benefitFromColumns({ type: "multibuy", buyQty: 2 }).ok).toBe(false)
    expect(benefitFromColumns({ type: "fixed", amount: null }).ok).toBe(false)
    expect(benefitFromColumns({}).ok).toBe(false)
  })
})

describe("field normalisation", () => {
  it("trims names and rejects empty or overlong ones", () => {
    expect(normalizeCouponName("  Promo  ")).toBe("Promo")
    expect(normalizeCouponName("   ")).toBeNull()
    expect(normalizeCouponName("x".repeat(81))).toBeNull()
    expect(normalizeCouponName(42)).toBeNull()
  })

  it("only accepts plain https image URLs", () => {
    expect(normalizeCouponImageUrl("https://img.example/a.png")).toBe(
      "https://img.example/a.png"
    )
    expect(normalizeCouponImageUrl("")).toBeNull()
    expect(normalizeCouponImageUrl(null)).toBeNull()
    expect(normalizeCouponImageUrl("http://img.example/a.png")).toBeUndefined()
    expect(normalizeCouponImageUrl("javascript:alert(1)")).toBeUndefined()
    expect(normalizeCouponImageUrl("data:image/png;base64,AAAA")).toBeUndefined()
    expect(normalizeCouponImageUrl("https://user:pw@img.example/a.png")).toBeUndefined()
    expect(normalizeCouponImageUrl("https://localhost/a.png")).toBeUndefined()
  })

  it("recognises a 22-char base64url nonce and nothing else", () => {
    expect(isValidNonce("hcLPDzERvvHzS4Vn0OLbAQ")).toBe(true)
    expect(isValidNonce("hcLPDzERvvHzS4Vn0OLbA")).toBe(false)
    expect(isValidNonce("hcLPDzERvvHzS4Vn0OLb+Q")).toBe(false)
    expect(isValidNonce(undefined)).toBe(false)
  })
})

describe("describeBenefit", () => {
  const titleOf = (d: string) => (d === D1 ? "Empanada" : undefined)

  it("names the product when it can, and stays readable when it cannot", () => {
    expect(describeBenefit({ type: "percent", percent: 10 })).toBe("10% de descuento")
    expect(describeBenefit({ type: "fixed", amount: 500, currency: "ARS" })).toBe(
      "ARS 500 de descuento"
    )
    expect(describeBenefit({ type: "fixed", amount: 500, currency: "SAT" })).toBe(
      "500 sat de descuento"
    )
    expect(
      describeBenefit({ type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] }, titleOf)
    ).toBe("2x1 en Empanada")
    expect(describeBenefit({ type: "multibuy", buyQty: 3, payQty: 2 })).toBe(
      "3x2 en cualquier producto"
    )
    expect(
      describeBenefit({ type: "buyXgetY", buyProductD: D1, giftProductD: D2 }, titleOf)
    ).toBe("Comprá Empanada y llevate un producto gratis")
  })

  it("names a single free product and counts units for a list", () => {
    expect(describeBenefit({ type: "freeItems", items: [{ d: D1, qty: 1 }] }, titleOf)).toBe(
      "Empanada gratis"
    )
    expect(describeBenefit({ type: "freeItems", items: [{ d: D1, qty: 3 }] }, titleOf)).toBe(
      "3 × Empanada gratis"
    )
    expect(
      describeBenefit(
        { type: "freeItems", items: [{ d: D1, qty: 2 }, { d: D2, qty: 1 }] },
        titleOf
      )
    ).toBe("3 productos gratis")
  })
})

describe("freeUnitsFor", () => {
  it("gives one free per completed 2x1 group", () => {
    const b: Benefit = { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] }
    expect(freeUnitsFor([line({ qty: 1 })], b)).toEqual([])
    expect(freeUnitsFor([line({ qty: 2 })], b)).toEqual([{ d: D1, qty: 1 }])
    expect(freeUnitsFor([line({ qty: 3 })], b)).toEqual([{ d: D1, qty: 1 }])
    expect(freeUnitsFor([line({ qty: 4 })], b)).toEqual([{ d: D1, qty: 2 }])
  })

  it("gives two free per completed 3x1 group", () => {
    const b: Benefit = { type: "multibuy", buyQty: 3, payQty: 1 }
    expect(freeUnitsFor([line({ qty: 3 })], b)).toEqual([{ d: D1, qty: 2 }])
  })

  it("applies to every line when no product is named", () => {
    const b: Benefit = { type: "multibuy", buyQty: 2, payQty: 1 }
    const free = freeUnitsFor([line({ qty: 2 }), line({ d: D2, qty: 2 })], b)
    expect(free).toEqual([
      { d: D1, qty: 1 },
      { d: D2, qty: 1 },
    ])
  })

  it("ignores lines other than the named product", () => {
    const b: Benefit = { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] }
    expect(freeUnitsFor([line({ d: D2, qty: 4 })], b)).toEqual([])
  })

  it("needs both products present for buyXgetY, and gives exactly one gift", () => {
    const b: Benefit = { type: "buyXgetY", buyProductD: D1, giftProductD: D2 }
    expect(freeUnitsFor([line()], b)).toEqual([])
    expect(freeUnitsFor([line({ d: D2 })], b)).toEqual([])
    expect(freeUnitsFor([line(), line({ d: D2, qty: 5 })], b)).toEqual([{ d: D2, qty: 1 }])
  })

  it("needs two units when the gift IS the purchase", () => {
    const b: Benefit = { type: "buyXgetY", buyProductD: D1, giftProductD: D1 }
    expect(freeUnitsFor([line({ qty: 1 })], b)).toEqual([])
    expect(freeUnitsFor([line({ qty: 2 })], b)).toEqual([{ d: D1, qty: 1 }])
  })

  it("hands over free items with no purchase condition", () => {
    const b: Benefit = { type: "freeItems", items: [{ d: D1, qty: 2 }] }
    expect(freeUnitsFor([line({ qty: 2 })], b)).toEqual([{ d: D1, qty: 2 }])
  })

  it("never gives more free items than the basket holds", () => {
    const b: Benefit = { type: "freeItems", items: [{ d: D1, qty: 3 }] }
    expect(freeUnitsFor([line({ qty: 1 })], b)).toEqual([{ d: D1, qty: 1 }])
    expect(freeUnitsFor([line({ d: D2, qty: 9 })], b)).toEqual([])
  })

  it("applies free items one by one — one missing does not sink the others", () => {
    const b: Benefit = {
      type: "freeItems",
      items: [{ d: D1, qty: 1 }, { d: D2, qty: 2 }],
    }
    expect(freeUnitsFor([line({ qty: 1 })], b)).toEqual([{ d: D1, qty: 1 }])
  })
})

describe("discountEntries", () => {
  it("takes a percentage off each currency subtotal", () => {
    const lines = [line({ qty: 2 }), line({ d: D2, currency: "USD", unitAmount: 10 })]
    expect(discountEntries(lines, { type: "percent", percent: 10 })).toEqual([
      { currency: "ARS", amount: 20 },
      { currency: "USD", amount: 1 },
    ])
  })

  it("rounds a percentage to two decimals, or to a whole sat", () => {
    expect(
      discountEntries([line({ unitAmount: 333 })], { type: "percent", percent: 10 })
    ).toEqual([{ currency: "ARS", amount: 33.3 }])
    expect(
      discountEntries([line({ unitAmount: 333, currency: "SAT" })], {
        type: "percent",
        percent: 10,
      })
    ).toEqual([{ currency: "SAT", amount: 33 }])
  })

  it("reports a fixed discount in its own currency, whatever the cart holds", () => {
    expect(
      discountEntries([line()], { type: "fixed", amount: 500, currency: "USD" })
    ).toEqual([{ currency: "USD", amount: 500 }])
  })

  it("values free units at their line's unit price", () => {
    const lines = [line({ qty: 2, unitAmount: 150 })]
    expect(
      discountEntries(lines, { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] })
    ).toEqual([{ currency: "ARS", amount: 150 }])
  })

  it("is empty when a product-conditioned coupon has nothing to give", () => {
    expect(
      discountEntries([line({ qty: 1 })], { type: "multibuy", buyQty: 2, payQty: 1 })
    ).toEqual([])
  })
})

describe("priceCart", () => {
  it("returns the plain quote when there is no coupon", () => {
    const priced = priceCart([line({ qty: 2 })], null, TABLE)
    expect(priced.gross.sats).toBe(200)
    expect(priced.net).toBe(priced.gross)
    expect(priced.discountSats).toBe(0)
    expect(priced.unmet).toBeNull()
  })

  it("subtracts a percentage exactly on a single-currency cart", () => {
    const priced = priceCart([line({ qty: 10 })], applied({ type: "percent", percent: 10 }), TABLE)
    expect(priced.gross.sats).toBe(1000)
    expect(priced.net.sats).toBe(900)
    expect(priced.discountSats).toBe(100)
    expect(priced.net.perCurrency).toEqual([{ currency: "ARS", subtotal: 900, sats: 900 }])
  })

  it("rounds the discounted total ONCE, not per line", () => {
    // Two lines at 0.5 sat each: rounding per line gives 2, the rule gives 1.
    const lines = [
      line({ unitAmount: 0.5, currency: "ARS" }),
      line({ d: D2, unitAmount: 0.5, currency: "ARS" }),
    ]
    const priced = priceCart(lines, null, TABLE)
    expect(priced.gross.exactSats).toBe(1)
    expect(priced.gross.sats).toBe(1)
  })

  it("converts a fixed discount authored in another currency", () => {
    // 1 USD = 1000 sats at this table, so USD 1 off an ARS 5000 cart.
    const priced = priceCart(
      [line({ qty: 50 })],
      applied({ type: "fixed", amount: 1, currency: "USD" }),
      TABLE
    )
    expect(priced.gross.sats).toBe(5000)
    expect(priced.discountSats).toBe(1000)
    expect(priced.net.sats).toBe(4000)
  })

  it("spreads a discount across currencies in proportion to what they contribute", () => {
    const lines = [
      line({ unitAmount: 1000 }), // ARS 1000 = 1000 sats
      line({ d: D2, currency: "USD", unitAmount: 1 }), // USD 1 = 1000 sats
    ]
    const priced = priceCart(lines, applied({ type: "percent", percent: 50 }), TABLE)
    expect(priced.gross.sats).toBe(2000)
    expect(priced.net.sats).toBe(1000)
    // Both rows halve, so the fiat breakdown still adds up to the sat total.
    expect(priced.net.perCurrency).toEqual([
      { currency: "ARS", subtotal: 500, sats: 500 },
      { currency: "USD", subtotal: 0.5, sats: 500 },
    ])
  })

  it("takes the bill to zero on a 100% coupon — the reclaim case", () => {
    const priced = priceCart(
      [line({ qty: 10 })],
      applied({ type: "percent", percent: 100 }),
      TABLE
    )
    expect(priced.net.sats).toBe(MIN_CHARGE_SATS)
    expect(priced.net.sats).toBe(0)
    expect(priced.discountSats).toBe(1000)
  })

  it("caps an over-generous fixed discount at the basket's value", () => {
    const priced = priceCart(
      [line({ qty: 1 })], // ARS 100
      applied({ type: "fixed", amount: 100_000, currency: "ARS" }),
      TABLE
    )
    expect(priced.net.sats).toBe(0)
    expect(priced.discountExactSats).toBe(100)
  })

  it("refuses to guess when the discount's currency has no rate", () => {
    const priced = priceCart(
      [line()],
      applied({ type: "fixed", amount: 5, currency: "USD" }),
      { SAT: 1, ARS: 1 }
    )
    expect(priced.unmet).toEqual({ kind: "unquotable", currency: "USD" })
    expect(priced.net).toBe(priced.gross)
  })

  it("names what the cart is missing so the shopper can act", () => {
    const priced = priceCart(
      [line({ qty: 1 })],
      applied({ type: "buyXgetY", buyProductD: D1, giftProductD: D2 }),
      TABLE
    )
    // buyXgetY names both sides, so this is "you still need the gift", not
    // "any of these will do".
    expect(priced.unmet).toEqual({
      kind: "needs-products",
      products: [{ d: D2, qty: 1 }],
      anyOf: false,
    })
  })

  it("says the cart is empty rather than blaming the coupon", () => {
    const priced = priceCart([], applied({ type: "percent", percent: 10 }), TABLE)
    expect(priced.unmet).toEqual({ kind: "empty-cart" })
  })

  it("reports the free units a 2x1 granted", () => {
    const priced = priceCart(
      [line({ qty: 2 })],
      applied({ type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] }),
      TABLE
    )
    expect(priced.freeUnits).toEqual([{ d: D1, qty: 1 }])
    expect(priced.net.sats).toBe(100)
  })

  it("takes the free items off the bill at their own line price", () => {
    // Two empanadas at 100 ARS and one 250 ARS coffee; the coupon gives away
    // one of each, so the shopper pays for the second empanada alone.
    const priced = priceCart(
      [line({ qty: 2 }), line({ d: D2, unitAmount: 250, title: "Café" })],
      applied({ type: "freeItems", items: [{ d: D1, qty: 1 }, { d: D2, qty: 1 }] }),
      TABLE
    )
    expect(priced.entries).toEqual([{ currency: "ARS", amount: 350 }])
    expect(priced.freeUnits).toEqual([{ d: D1, qty: 1 }, { d: D2, qty: 1 }])
    expect(priced.net.sats).toBe(100)
  })

  it("asks for any one of the free products, not all of them", () => {
    const priced = priceCart(
      [line({ d: D3 })],
      applied({ type: "freeItems", items: [{ d: D1, qty: 1 }, { d: D2, qty: 2 }] }),
      TABLE
    )
    expect(priced.unmet).toEqual({
      kind: "needs-products",
      products: [{ d: D1, qty: 1 }, { d: D2, qty: 2 }],
      anyOf: true,
    })
  })
})

describe("voucher", () => {
  const input = {
    nonce: "hcLPDzERvvHzS4Vn0OLbAQ",
    owner: "a".repeat(64),
    couponId: "33333333-3333-4333-8333-333333333333",
    name: "Promo",
    description: "10% en todo",
    benefit: { type: "percent", percent: 10 } as Benefit,
    phase: "minted" as const,
  }

  it("carries the nonce, owner and coupon in tags and content", () => {
    const body = voucherEventBody(input)
    expect(body.kind).toBe(20402)
    expect(body.tags).toEqual([
      ["nonce", input.nonce],
      ["p", input.owner],
      ["coupon", input.couponId],
      ["phase", "minted"],
    ])
    const parsed = parseVoucherContent(body.content)
    expect(parsed).toMatchObject({
      v: 1,
      nonce: input.nonce,
      owner: input.owner,
      coupon: { type: "percent", percent: 10 },
      phase: "minted",
    })
  })

  it("adds a NIP-40 expiration tag only when the coupon expires", () => {
    expect(voucherEventBody(input).tags.some((t) => t[0] === "expiration")).toBe(false)
    const dated = voucherEventBody({ ...input, expiresAt: 1_800_000_000 })
    expect(dated.tags).toContainEqual(["expiration", "1800000000"])
    expect(parseVoucherContent(dated.content)?.expiresAt).toBe(1_800_000_000)
  })

  it("stamps claimedAt on a claimed voucher only", () => {
    const minted = voucherEventBody({ ...input, claimedAt: 1_700_000_000 })
    expect(parseVoucherContent(minted.content)?.claimedAt).toBeUndefined()
    const claimed = voucherEventBody({
      ...input,
      phase: "claimed",
      claimedAt: 1_700_000_000,
    })
    expect(parseVoucherContent(claimed.content)?.claimedAt).toBe(1_700_000_000)
  })

  it("omits an absent image rather than writing null", () => {
    expect(voucherEventBody({ ...input, image: null }).content).not.toContain("image")
    expect(
      parseVoucherContent(
        voucherEventBody({ ...input, image: "https://i.example/a.png" }).content
      )?.image
    ).toBe("https://i.example/a.png")
  })

  it("discards an unknown version instead of migrating it", () => {
    expect(parseVoucherContent(JSON.stringify({ v: 2, nonce: input.nonce }))).toBeNull()
  })

  it("rejects content that is not a voucher", () => {
    expect(parseVoucherContent("not json")).toBeNull()
    expect(parseVoucherContent(JSON.stringify({ v: 1, nonce: "short" }))).toBeNull()
    expect(
      parseVoucherContent(
        JSON.stringify({ ...input, v: 1, coupon: { type: "percent", percent: 999 } })
      )
    ).toBeNull()
  })
})

/**
 * A discount can name the products it applies to. No list means the whole
 * basket, which is the default a merchant expects from "10% off".
 */
describe("product scope", () => {
  it("accepts a list, dedupes it, and drops an empty one", () => {
    const many = parseBenefit({ type: "percent", percent: 10, productDs: [D1, D2, D1] })
    expect(many).toEqual({
      ok: true,
      value: { type: "percent", percent: 10, productDs: [D1, D2] },
    })

    // Empty means "all", which the benefit spells as an absent key — not as a
    // list that can never match anything.
    const empty = parseBenefit({ type: "percent", percent: 10, productDs: [] })
    expect(empty).toEqual({ ok: true, value: { type: "percent", percent: 10 } })
  })

  it("still reads the singular key a minted coupon may have frozen", () => {
    expect(parseBenefit({ type: "multibuy", buyQty: 2, payQty: 1, productD: D1 })).toEqual({
      ok: true,
      value: { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] },
    })
  })

  it("rejects a bad product id and an oversized list", () => {
    expect(parseBenefit({ type: "percent", percent: 10, productDs: ["nope"] }).ok).toBe(false)
    expect(
      parseBenefit({
        type: "percent",
        percent: 10,
        productDs: Array.from({ length: 51 }, () => D1),
      }).ok
    ).toBe(false)
  })

  it("takes the percentage off only the named products", () => {
    const lines = [
      line({ d: D1, unitAmount: 100 }),
      line({ d: D2, unitAmount: 900, title: "Vino" }),
    ]
    expect(discountEntries(lines, { type: "percent", percent: 10, productDs: [D1] })).toEqual([
      { currency: "ARS", amount: 10 },
    ])
    // Same cart, no scope: 10% of the whole 1000.
    expect(discountEntries(lines, { type: "percent", percent: 10 })).toEqual([
      { currency: "ARS", amount: 100 },
    ])
  })

  it("caps a fixed amount at what the named products are worth", () => {
    const lines = [
      line({ d: D1, unitAmount: 200 }),
      line({ d: D2, unitAmount: 5000, title: "Vino" }),
    ]
    // ARS 500 off D1, but D1 is only worth 200 — the rest of the cart is not
    // the coupon's to discount.
    expect(
      discountEntries(lines, { type: "fixed", amount: 500, currency: "ARS", productDs: [D1] })
    ).toEqual([{ currency: "ARS", amount: 200 }])
  })

  it("counts a 2x1 per product across the whole list", () => {
    const lines = [
      line({ d: D1, qty: 2 }),
      line({ d: D2, qty: 2, title: "Vino" }),
      line({ d: D3, qty: 2, title: "Postre" }),
    ]
    expect(freeUnitsFor(lines, { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1, D2] }))
      .toEqual([
        { d: D1, qty: 1 },
        { d: D2, qty: 1 },
      ])
  })

  it("reports the missing product instead of pricing nothing", () => {
    const cart = [line({ d: D2, title: "Vino" })]
    const priced = priceCart(cart, applied({ type: "percent", percent: 10, productDs: [D1] }), TABLE)
    expect(priced.unmet).toEqual({
      kind: "needs-products",
      products: [{ d: D1, qty: 1 }],
      // One of the named products is enough for a percentage.
      anyOf: true,
    })
    expect(priced.net.sats).toBe(priced.gross.sats)
  })

  it("names the scope when describing the coupon", () => {
    const titleOf = (d: string) => (d === D1 ? "Empanada" : "Vino")
    expect(describeBenefit({ type: "percent", percent: 10 }, titleOf)).toBe("10% de descuento")
    expect(describeBenefit({ type: "percent", percent: 10, productDs: [D1] }, titleOf)).toBe(
      "10% de descuento en Empanada"
    )
    expect(
      describeBenefit({ type: "percent", percent: 10, productDs: [D1, D2] }, titleOf)
    ).toBe("10% de descuento en 2 productos")
  })

  it("round-trips a scope through the columns", () => {
    const benefit: Benefit = { type: "fixed", amount: 500, currency: "ARS", productDs: [D1, D2] }
    expect(benefitFromColumns(benefitToColumns(benefit))).toEqual({ ok: true, value: benefit })
  })
})

describe("discountByLine", () => {
  /**
   * The per-line split has to add up to what discountEntries says, or the order
   * book and the invoice tell two different stories about the same sale.
   */
  const totalOf = (amounts: readonly number[]) =>
    amounts.reduce((sum, amount) => sum + amount, 0)

  it("puts free units on their own line, not on the basket", () => {
    const lines = [line({ d: D1, qty: 2 }), line({ d: D2, qty: 1 })]
    const benefit: Benefit = { type: "freeItems", items: [{ d: D1, qty: 1 }] }

    expect(discountByLine(lines, benefit)).toEqual([100, 0])
    expect(totalOf(discountByLine(lines, benefit))).toBe(
      discountEntries(lines, benefit)[0]!.amount
    )
  })

  it("splits a multibuy onto the product that repeats", () => {
    const lines = [line({ d: D1, qty: 4 }), line({ d: D2, qty: 3 })]
    const benefit: Benefit = { type: "multibuy", buyQty: 2, payQty: 1, productDs: [D1] }

    // 4 units, 2x1 ⇒ 2 free.
    expect(discountByLine(lines, benefit)).toEqual([200, 0])
  })

  it("takes a percentage off every line it is scoped to", () => {
    const lines = [line({ d: D1, qty: 2 }), line({ d: D2, qty: 1 })]

    expect(discountByLine(lines, { type: "percent", percent: 10 })).toEqual([20, 10])
    expect(
      discountByLine(lines, { type: "percent", percent: 10, productDs: [D2] })
    ).toEqual([0, 10])
  })

  it("spreads a lump sum only over the lines it can apply to", () => {
    const lines = [
      line({ d: D1, qty: 1, unitAmount: 300 }),
      line({ d: D2, qty: 1, unitAmount: 100 }),
      line({ d: D3, qty: 1, unitAmount: 5, currency: "USD" }),
    ]
    const benefit: Benefit = { type: "fixed", amount: 200, currency: "ARS" }

    // 200 over ARS 400 of eligible basket: 150 / 50, and nothing on the USD row.
    expect(discountByLine(lines, benefit)).toEqual([150, 50, 0])
    expect(totalOf(discountByLine(lines, benefit))).toBe(200)
  })

  it("caps a lump sum at what the scoped products are worth", () => {
    const lines = [line({ d: D1, qty: 1, unitAmount: 50 }), line({ d: D2, qty: 1 })]
    const benefit: Benefit = { type: "fixed", amount: 500, currency: "ARS", productDs: [D1] }

    expect(discountByLine(lines, benefit)).toEqual([50, 0])
  })
})

describe("tope de descuento", () => {
  const CAP: Benefit["cap"] = { amount: 500, currency: "ARS" }

  it("holds a percentage to its ceiling", () => {
    // ARS 10.000 al 20% son 2.000; el tope deja 500.
    const lines = [line({ qty: 100 })] // ARS 10.000
    const capped: Benefit = { type: "percent", percent: 20, cap: CAP }

    expect(discountEntries(lines, capped)).toEqual([{ currency: "ARS", amount: 500 }])
    expect(priceCart(lines, applied(capped), TABLE).net.sats).toBe(9_500)
  })

  it("leaves a discount that never reaches the ceiling alone", () => {
    const lines = [line({ qty: 10 })] // ARS 1.000
    const capped: Benefit = { type: "percent", percent: 20, cap: CAP }

    expect(discountEntries(lines, capped)).toEqual([{ currency: "ARS", amount: 200 }])
  })

  it("caps every type, not just percentages", () => {
    const lines = [line({ qty: 2, unitAmount: 2_000 })] // 2 × ARS 2.000
    const free: Benefit = {
      type: "freeItems",
      items: [{ d: D1, qty: 1 }],
      cap: CAP,
    }

    // Un producto gratis valdría 2.000; el tope lo deja en 500.
    expect(discountEntries(lines, free)).toEqual([{ currency: "ARS", amount: 500 }])
  })

  it("scales the per-line split so it still adds up to the ceiling", () => {
    const lines = [
      line({ d: D1, qty: 1, unitAmount: 3_000 }),
      line({ d: D2, qty: 1, unitAmount: 1_000 }),
    ]
    const capped: Benefit = { type: "percent", percent: 50, cap: CAP }

    // Sin tope serían 1.500 y 500; con tope, la misma proporción sobre 500.
    expect(discountByLine(lines, capped)).toEqual([375, 125])
    expect(discountByLine(lines, capped).reduce((a, b) => a + b, 0)).toBe(500)
  })

  it("only clamps its own currency", () => {
    const lines = [
      line({ d: D1, qty: 10 }), // ARS 1.000
      line({ d: D2, qty: 1, unitAmount: 100, currency: "USD" }),
    ]
    const capped: Benefit = { type: "percent", percent: 50, cap: CAP }

    expect(discountEntries(lines, capped)).toEqual([
      { currency: "ARS", amount: 500 },
      { currency: "USD", amount: 50 },
    ])
  })

  it("says the ceiling out loud", () => {
    expect(describeBenefit({ type: "percent", percent: 20, cap: CAP })).toBe(
      "20% de descuento (hasta ARS 500)"
    )
  })

  it("round-trips through the columns", () => {
    const back = benefitFromColumns(
      benefitToColumns({ type: "percent", percent: 20, cap: CAP })
    )
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.value).toEqual({ type: "percent", percent: 20, cap: CAP })
  })

  it("refuses a ceiling that is not a positive amount in a real currency", () => {
    const withCap = (cap: unknown) => parseBenefit({ type: "percent", percent: 10, cap })
    expect(withCap({ amount: 0, currency: "ARS" }).ok).toBe(false)
    expect(withCap({ amount: -5, currency: "ARS" }).ok).toBe(false)
    expect(withCap({ amount: 5, currency: "EUR" }).ok).toBe(false)
    expect(withCap({ amount: 10.5, currency: "SAT" }).ok).toBe(false)
    expect(withCap({ amount: 10, currency: "SAT" }).ok).toBe(true)
    // Absent stays absent — a coupon without a ceiling has no key at all.
    expect(parseBenefit({ type: "percent", percent: 10 })).toEqual({
      ok: true,
      value: { type: "percent", percent: 10 },
    })
  })
})
