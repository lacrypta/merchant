"use client"

import { RefreshCw } from "lucide-react"
import * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { TickerChip, TickerChipButton } from "@/components/ui/ticker-chip"

/**
 * How old the exchange rate is.
 *
 * Appears in exactly two places — beside the currency selector in the cart,
 * and above the amount at checkout — so the customer can always tell whether
 * the number they are looking at is current.
 *
 * Once an invoice exists this is REPLACED by "Importe fijado": the BOLT-11
 * amount is frozen, and if the UI does not say so a rate move mid-payment
 * reads as the shop changing the price under them.
 */
export function RateFreshnessChip({ locked }: { locked?: boolean }) {
  const { ratesAsOf, ratesStale, refreshRates } = useCart()
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (locked) return
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [locked])

  if (locked) {
    return <TickerChip tone="success">Importe fijado</TickerChip>
  }

  if (ratesAsOf === null) {
    return <TickerChip>Cotización…</TickerChip>
  }

  const ageMs = Math.max(0, now - ratesAsOf)
  const tone =
    ratesStale || ageMs > 10 * 60_000
      ? "danger"
      : ageMs > 2 * 60_000
        ? "warning"
        : "neutral"

  return (
    <TickerChipButton
      tone={tone}
      onClick={refreshRates}
      aria-label="Actualizar cotización"
    >
      <RefreshCw className="size-3" aria-hidden />
      Cotización · {formatAge(ageMs)}
    </TickerChipButton>
  )
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `hace ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  return `hace ${Math.round(m / 60)} h`
}
