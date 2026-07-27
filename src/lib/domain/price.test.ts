import { describe, expect, it } from "vitest"

import { formatPrice } from "./price"

describe("formatPrice", () => {
  it("shows no decimals on whole amounts", () => {
    // Pesos are rarely priced to the centavo; "ARS 5.100,00" is just noise.
    expect(formatPrice(5100, "ARS")).toBe("ARS 5.100")
    expect(formatPrice(2618, "EUR")).toBe("2.618 EUR")
  })

  it("shows exactly two decimals on fractional amounts", () => {
    // The bug this guards: a converted total rendered as "2.618,2" — one
    // trailing decimal, which reads as money in no locale at all.
    expect(formatPrice(2618.2, "EUR")).toBe("2.618,20 EUR")
    expect(formatPrice(2618.25, "EUR")).toBe("2.618,25 EUR")
    expect(formatPrice(0.5, "USD")).toBe("USD 0,50")
  })

  it("never gives satoshis a fractional part", () => {
    expect(formatPrice(4875, "SAT")).toBe("4.875 sat")
    expect(formatPrice(4875.6, "SAT")).toBe("4.876 sat")
  })

  it("uses the currency CODE, never a bare $", () => {
    // A catalog can price in ARS and USD at once, and `$` reads as either —
    // ambiguous by a factor of about a thousand.
    expect(formatPrice(1, "ARS")).not.toContain("$")
    expect(formatPrice(1, "USD")).not.toContain("$")
  })

  it("passes unknown currencies through as a suffix", () => {
    expect(formatPrice(1234, "USDC")).toBe("1.234 USDC")
  })
})
