import { describe, expect, it } from "vitest"

import {
  convert,
  fromSats,
  isQuotable,
  quote,
  rateFreshness,
  satPriceFromUnitsPerBtc,
  toSats,
  type RateSnapshot,
} from "./rates"

/** Real Yadio numbers, captured live: units per BTC. */
const YADIO = { ARS: 103_657_091.58, USD: 65_017.49, EUR: 57_031.52 }
const T = satPriceFromUnitsPerBtc(YADIO)

describe("satPriceFromUnitsPerBtc", () => {
  it("divides by 1e8 and pins SAT to exactly 1", () => {
    expect(T.SAT).toBe(1)
    expect(T.ARS).toBeCloseTo(1.0365709158, 10)
    expect(T.USD).toBeCloseTo(0.0006501749, 10)
  })

  it("keeps every currency the oracle quotes, not just ARS/USD/SAT", () => {
    // isSupportedCurrency() is the merchant's AUTHORING whitelist. Reusing it
    // here would blank the cart of anyone pricing in euros.
    expect(isQuotable(T, "EUR")).toBe(true)
    expect(isQuotable(T, "eur")).toBe(true)
    expect(isQuotable(T, "USDC")).toBe(false)
  })

  it("drops junk instead of coercing it — a 0 rate would make things free", () => {
    const t = satPriceFromUnitsPerBtc({
      ARS: 103_657_091.58,
      ZERO: 0,
      NEG: -5,
      NAN: Number.NaN,
      INF: Number.POSITIVE_INFINITY,
      TEXT: "nope",
      toolong: 123,
      "": 1,
    })
    expect(Object.keys(t).sort()).toEqual(["ARS", "SAT"])
  })

  it("never lets the feed override the SAT identity", () => {
    expect(satPriceFromUnitsPerBtc({ SAT: 999 }).SAT).toBe(1)
  })
})

describe("conversion", () => {
  it("round-trips fiat → sats → fiat", () => {
    const back = fromSats(toSats(7300, "ARS", T)!, "ARS", T)
    expect(back).toBeCloseTo(7300, 6)
  })

  it("agrees with the BTC price by hand", () => {
    // 1 USD should be 1e8 / 65017.49 sats.
    expect(toSats(1, "USD", T)).toBeCloseTo(1e8 / YADIO.USD, 4)
  })

  it("treats sats as a no-op currency", () => {
    expect(toSats(21, "SAT", T)).toBe(21)
    expect(convert(21, "SAT", "SAT", T)).toBe(21)
  })

  it("returns null rather than 0 for an unknown currency", () => {
    // 0 would silently make the product free; null forces a caller decision.
    expect(toSats(10, "USDC", T)).toBeNull()
    expect(convert(10, "USDC", "ARS", T)).toBeNull()
  })
})

describe("quote", () => {
  it("rounds the TOTAL up once, not each line", () => {
    // Three lines that each land on .4 of a sat. Ceiling-per-line would bill
    // 3 sats; the correct answer is ceil(1.2) = 2.
    const table = { SAT: 1, TST: 1 / 0.4 }
    const q = quote([{ amount: 1, currency: "TST" }, { amount: 1, currency: "TST" }, { amount: 1, currency: "TST" }], table)
    expect(q.sats).toBe(2)
  })

  it("always rounds up, so the merchant is never short", () => {
    const table = { SAT: 1, TST: 1000 }
    expect(quote([{ amount: 1, currency: "TST" }], table).sats).toBe(1)
  })

  it("emits whole-sat millisatoshis", () => {
    const q = quote([{ amount: 7300, currency: "ARS" }], T)
    expect(q.msat % 1000).toBe(0)
    expect(q.msat).toBe(q.sats * 1000)
  })

  it("keeps a large peso total exact", () => {
    // Half a million pesos is an ordinary dinner bill here. Carried in msat
    // this arithmetic passes Number.MAX_SAFE_INTEGER and loses digits.
    const q = quote([{ amount: 500_000, currency: "ARS" }], T)
    expect(q.sats).toBe(Math.ceil(500_000 / T.ARS))
    expect(Number.isSafeInteger(q.msat)).toBe(true)
  })

  it("sums mixed currencies into one sat total", () => {
    const q = quote(
      [
        { amount: 7300, currency: "ARS" },
        { amount: 5, currency: "USD" },
        { amount: 1000, currency: "SAT" },
      ],
      T
    )
    const expected = Math.ceil(7300 / T.ARS + 5 / T.USD + 1000)
    expect(q.sats).toBe(expected)
    expect(q.perCurrency).toHaveLength(3)
    expect(q.unquotable).toEqual([])
  })

  it("merges repeated currencies into one subtotal", () => {
    const q = quote(
      [
        { amount: 100, currency: "ARS" },
        { amount: 200, currency: "ARS" },
      ],
      T
    )
    expect(q.perCurrency).toEqual([
      { currency: "ARS", subtotal: 300, sats: 300 / T.ARS },
    ])
  })

  it("reports unquotable currencies instead of throwing or silently dropping", () => {
    const q = quote(
      [
        { amount: 100, currency: "ARS" },
        { amount: 5, currency: "USDC" },
      ],
      T
    )
    expect(q.unquotable).toEqual(["USDC"])
    // The quotable part is still priced so the cart can render a split total.
    expect(q.sats).toBe(Math.ceil(100 / T.ARS))
  })

  it("prices an empty basket at zero", () => {
    expect(quote([], T)).toMatchObject({ sats: 0, msat: 0, unquotable: [] })
  })
})

describe("rateFreshness", () => {
  const at = (ageMs: number, stale = false): RateSnapshot => ({
    base: "SAT",
    satPrice: T,
    asOf: 1_000_000_000_000 - ageMs,
    stale,
    source: "yadio",
  })
  const now = 1_000_000_000_000

  it("tiers by age", () => {
    expect(rateFreshness(at(10_000), now)).toBe("fresh")
    expect(rateFreshness(at(5 * 60_000), now)).toBe("aging")
    expect(rateFreshness(at(11 * 60_000), now)).toBe("old")
    expect(rateFreshness(at(20 * 60_000), now)).toBe("unusable")
  })

  it("never calls a stale snapshot fresh, however recent its timestamp", () => {
    expect(rateFreshness(at(1_000, true), now)).toBe("aging")
  })
})
