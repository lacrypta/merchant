/**
 * Currency conversion, expressed against a satoshi base.
 *
 * Everything in this module is pure: no fetch, no clock beyond what the caller
 * passes in. The network side lives in src/lib/server/yadio.ts.
 *
 * THE ONE RULE: a total is the ceiling of the sum, never the sum of the
 * ceilings. Rounding per line overcharges by up to (lines - 1) sats and makes
 * the numbers on screen not add up to the number on the invoice — which, at a
 * till, is the kind of thing that ends an argument badly.
 */

/**
 * The value of ONE satoshi, expressed in each currency.
 *
 * So `satPrice.ARS = 1.04` means one sat is worth 1.04 pesos. `satPrice.SAT`
 * is 1 by definition. This direction (rather than sats-per-unit) is what
 * lawalletio/pos uses and it keeps the SAT identity trivially true.
 */
export type SatPriceTable = Readonly<Record<string, number>>

export interface RateSnapshot {
  base: "SAT"
  satPrice: SatPriceTable
  /** Milliseconds since epoch — the ORACLE's timestamp, not ours. */
  asOf: number
  /** True when this is a last-good value served because the oracle failed. */
  stale: boolean
  source: "yadio"
}

/** Currency codes we're willing to put in the table at all. */
const CODE = /^[A-Z]{3,5}$/

/**
 * Yadio publishes `1 BTC = N units`. One BTC is 1e8 sats, so the value of a
 * single sat is N/1e8.
 *
 * Unparseable or non-positive entries are dropped rather than coerced: a rate
 * of 0 would make a product free, and a NaN would make a total silently
 * vanish. Absent from the table means "we can't quote this", which every
 * caller already has to handle.
 */
export function satPriceFromUnitsPerBtc(
  unitsPerBtc: Readonly<Record<string, unknown>>
): SatPriceTable {
  const table: Record<string, number> = { SAT: 1 }

  for (const [rawCode, rawRate] of Object.entries(unitsPerBtc)) {
    const code = rawCode.trim().toUpperCase()
    if (!CODE.test(code) || code === "SAT") continue

    const n = typeof rawRate === "number" ? rawRate : Number(rawRate)
    if (!Number.isFinite(n) || n <= 0) continue

    table[code] = n / 1e8
  }

  return table
}

/**
 * Whether we can convert this currency.
 *
 * Deliberately NOT isSupportedCurrency() from price.ts — that is the
 * merchant's AUTHORING whitelist (ARS/USD/SAT) and would refuse EUR, which
 * the oracle quotes perfectly well. Convertibility is a property of the rate
 * table, not of what our form lets you type.
 */
export function isQuotable(table: SatPriceTable, currency: string): boolean {
  const rate = table[currency.toUpperCase()]
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0
}

/** Fractional sats. Null when the currency isn't in the table. */
export function toSats(
  amount: number,
  currency: string,
  table: SatPriceTable
): number | null {
  const rate = table[currency.toUpperCase()]
  if (!rate || !Number.isFinite(amount)) return null
  return amount / rate
}

/** The value of `sats` satoshis in `currency`. Null when unquotable. */
export function fromSats(
  sats: number,
  currency: string,
  table: SatPriceTable
): number | null {
  const rate = table[currency.toUpperCase()]
  if (!rate || !Number.isFinite(sats)) return null
  return sats * rate
}

export function convert(
  amount: number,
  from: string,
  to: string,
  table: SatPriceTable
): number | null {
  const sats = toSats(amount, from, table)
  return sats === null ? null : fromSats(sats, to, table)
}

export interface QuoteEntry {
  amount: number
  currency: string
}

export interface Quote {
  /** Whole sats, rounded UP once over the whole basket. What gets charged. */
  sats: number
  /**
   * The same total before rounding — for DISPLAY only.
   *
   * Converting `sats` back to pesos to show a total is off by up to one
   * satoshi's worth, which is enough to print "Total ARS 5.101" under a list
   * of items that plainly adds to 5.100. The customer reads that as a bug,
   * and they are not wrong to.
   */
  exactSats: number
  /** Always a multiple of 1000 — plenty of wallets reject sub-sat msat. */
  msat: number
  /** Subtotal per currency, in the order first seen. Display only. */
  perCurrency: { currency: string; subtotal: number; sats: number }[]
  /** Currencies the table couldn't quote. Non-empty ⇒ do not charge. */
  unquotable: string[]
}

/**
 * Price a basket in sats.
 *
 * Computes in SATS, never in msat. `500_000 ARS` at a plausible rate is ~5e13
 * sats-worth of intermediate arithmetic, which is comfortable; the same
 * expression carried in msat reaches 5e16 and blows past
 * Number.MAX_SAFE_INTEGER, silently losing the low digits of a real total.
 *
 * `unquotable` is returned rather than thrown: the cart still has to render,
 * and the customer is owed a specific reason for why they can't pay yet.
 */
export function quote(entries: readonly QuoteEntry[], table: SatPriceTable): Quote {
  const byCurrency = new Map<string, number>()
  const unquotable = new Set<string>()

  for (const e of entries) {
    const currency = e.currency.toUpperCase()
    if (!isQuotable(table, currency)) {
      unquotable.add(currency)
      continue
    }
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + e.amount)
  }

  // Accumulate fractional sats across every currency, THEN round.
  let exact = 0
  const perCurrency: Quote["perCurrency"] = []
  for (const [currency, subtotal] of byCurrency) {
    const sats = toSats(subtotal, currency, table) ?? 0
    exact += sats
    perCurrency.push({ currency, subtotal, sats })
  }

  const sats = Math.ceil(exact)
  return {
    sats,
    exactSats: exact,
    msat: sats * 1000,
    perCurrency,
    unquotable: [...unquotable],
  }
}

/** How old a snapshot is allowed to get before we refuse to quote at all. */
export const RATE_HARD_MAX_AGE_MS = 15 * 60_000

export type RateFreshness = "fresh" | "aging" | "old" | "unusable"

/**
 * Freshness tiers, so the chip and the pay button agree on one definition.
 * `stale` (the oracle failed and we're serving a memo) is never "fresh"
 * however recent the underlying timestamp is.
 */
export function rateFreshness(snapshot: RateSnapshot, now: number): RateFreshness {
  const age = now - snapshot.asOf
  if (age > RATE_HARD_MAX_AGE_MS) return "unusable"
  if (age > 10 * 60_000) return "old"
  if (age > 2 * 60_000 || snapshot.stale) return "aging"
  return "fresh"
}
