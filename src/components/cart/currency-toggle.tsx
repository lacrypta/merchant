"use client"

import * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { SegmentedControl } from "@/components/ui/segmented-control"

/**
 * Which currency the whole storefront quotes in.
 *
 * It used to live inside the cart, which put a page-wide setting behind a
 * drawer: someone comparing prices in the product list had to open their order
 * to change how those prices read. Up in the header it is where the thing it
 * affects is.
 *
 * The options are the three the app always quotes plus whatever the shop
 * actually prices in — minus any currency there is no rate for, because
 * offering a currency we cannot convert is a switch that shows dashes.
 */
export function CurrencyToggle({ className }: { className?: string }) {
  const { cart, rates, displayCurrency, setDisplayCurrency } = useCart()

  const currencies = React.useMemo(() => {
    const seen = new Set<string>(["ARS", "USD", "SAT"])
    for (const l of cart.lines) seen.add(l.currency)
    return [...seen].filter((c) => c === "SAT" || rates?.[c])
  }, [cart.lines, rates])

  return (
    <SegmentedControl
      aria-label="Moneda"
      className={className}
      value={displayCurrency}
      onValueChange={setDisplayCurrency}
      options={currencies.map((c) => ({ value: c, label: c }))}
    />
  )
}
