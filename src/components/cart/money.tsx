"use client"

import { useCart } from "@/components/cart/cart-provider"
import { formatPrice } from "@/lib/domain/price"
import { convert, isQuotable } from "@/lib/domain/rates"

/**
 * The one place a converted amount is rendered.
 *
 * Two rules live here so they cannot drift apart across components:
 *
 *  1. The AUTHORED price is the primary number, in the currency the merchant
 *     actually chose. A converted figure never occupies the slot where an
 *     authored one belongs.
 *  2. The `≈` line appears only when the display currency differs, so a shop
 *     priced entirely in pesos, viewed in pesos, shows no noise at all.
 */
export function Approx({
  amount,
  currency,
  className,
}: {
  amount: number
  currency: string
  className?: string
}) {
  const { rates, displayCurrency } = useCart()

  if (!rates || currency === displayCurrency) return null

  if (!isQuotable(rates, currency)) {
    return (
      <span className={className} title={`No tenemos cotización para ${currency}`}>
        Sin cotización
      </span>
    )
  }

  const converted = convert(amount, currency, displayCurrency, rates)
  if (converted === null) return null

  return (
    <span className={className}>
      ≈ {formatPrice(roundFor(converted, displayCurrency), displayCurrency)}
    </span>
  )
}

/** Sats are whole; fiat keeps its cents. */
export function roundFor(value: number, currency: string): number {
  return currency === "SAT" ? Math.round(value) : value
}
