/**
 * Currencies the MERCHANT can author in, matching
 * lawalletio/mobile-pos `AvailableCurrencies` exactly. SAT is the base unit
 * for conversion (rates are normalised to per-sat).
 */
export type Currency = "ARS" | "USD" | "SAT"

export const CURRENCIES: readonly Currency[] = ["ARS", "USD", "SAT"] as const

export function isSupportedCurrency(v: string): v is Currency {
  return (CURRENCIES as readonly string[]).includes(v)
}

/**
 * A price READ from nostr.
 *
 * `currency` is deliberately a plain string, not the narrow `Currency` union:
 * real merchants on nostr price in EUR, USDC, GBP and more, and dropping
 * those products would render their whole storefront empty — far worse than
 * showing a price we can't convert. Conversion and the LaPOS projection
 * gate on isSupportedCurrency(); display does not.
 */
export interface Price {
  amount: number
  currency: string
  /** NIP-99 recurring interval. Never written by us; round-tripped on parse. */
  frequency?: string
}

/** A price the merchant authored here — always convertible. */
export interface AuthoredPrice extends Price {
  currency: Currency
}

const SATS_PER_BTC = 100_000_000

/**
 * Parse a NIP-99 `["price", "<amount>", "<currency>", "<frequency>"]` tag.
 *
 * The spec's own examples use lowercase ("btc", "eth") and implementations
 * disagree, so currency matching is case-insensitive. `btc` is converted to
 * sats and `sats`/`sat` normalise to SAT; every other code is preserved
 * verbatim for display.
 */
export function parsePriceTag(tag: string[] | undefined): Price | null {
  if (!tag || tag[0] !== "price") return null

  const rawAmount = tag[1]
  const rawCurrency = tag[2]
  if (!rawAmount || !rawCurrency) return null

  // Accept "1.234,56" (es-AR) and "1234.56" alike.
  const normalised = rawAmount.includes(",")
    ? rawAmount.replace(/\./g, "").replace(",", ".")
    : rawAmount
  const amount = Number.parseFloat(normalised)
  if (!Number.isFinite(amount) || amount < 0) return null

  const frequency = tag[3] || undefined
  const c = rawCurrency.trim().toUpperCase()

  if (c === "BTC") {
    return { amount: Math.round(amount * SATS_PER_BTC), currency: "SAT", frequency }
  }
  if (c === "SAT" || c === "SATS") {
    return { amount: Math.round(amount), currency: "SAT", frequency }
  }
  return { amount, currency: c, frequency }
}

/** Serialise an amount for the `price` tag — always a plain dot-decimal string. */
export function formatAmount(price: Price): string {
  return price.currency === "SAT"
    ? String(Math.round(price.amount))
    : String(Number(price.amount.toFixed(2)))
}

/**
 * Display formatting: `ARS 1.234`, `USD 1.234`, `1.234 sat`.
 * Anything else falls back to `1.234,00 EUR`.
 *
 * Deliberately NOT the bare `$` that lawalletio/mobile-pos and menu-lacrypta
 * use for ARS. A catalog can price in both ARS and USD at once, and `$` reads
 * as either depending on who is looking — a price that is ambiguous by a
 * factor of ~1000 is worse than one that is two characters longer. Sats keep
 * the suffix form, which is the universal nostr convention.
 *
 * NOTE: never use the ₿ sign — the Standerd typeface has no glyph for U+20BF.
 */
export function formatPrice(amount: number, currency: string): string {
  const isSat = currency === "SAT"
  const n = new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: isSat ? 0 : 2,
  }).format(amount)

  switch (currency) {
    case "SAT":
      return `${n} sat`
    case "USD":
      return `USD ${n}`
    case "ARS":
      return `ARS ${n}`
    default:
      return `${n} ${currency}`
  }
}
