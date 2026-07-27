"use client"

import { ShoppingBag } from "lucide-react"

import { useCart } from "@/components/cart/cart-provider"
import { Button } from "@/components/ui/button"
import { Odometer } from "@/components/ui/odometer"
import { formatPrice } from "@/lib/domain/price"
import { roundFor } from "@/components/cart/money"
import { fromSats } from "@/lib/domain/rates"

/**
 * The navbar cart pill.
 *
 * Hidden at zero — an empty cart has nothing to open, and a permanently-zero
 * control on a shop that may never sell anything is chrome for its own sake.
 * Discovery on mobile comes from the sticky bar instead.
 *
 * Also hidden from `lg` up, where <CartAside> is already showing the order in
 * full: a button that opens a modal duplicating the panel next to it is just
 * a second way to see the same thing.
 */
export function CartButton() {
  const { count, quote, displayCurrency, setPanelOpen, rates } = useCart()

  if (count === 0) return null

  const total =
    quote && rates ? fromSats(quote.exactSats, displayCurrency, rates) : null

  return (
    <Button
      variant="secondary"
      size="sm"
      className="enter-pop lg:hidden"
      onClick={() => setPanelOpen(true)}
      aria-label={`Ver el pedido, ${count} ${count === 1 ? "producto" : "productos"}`}
    >
      <ShoppingBag className="size-4" aria-hidden />
      <Odometer value={count} format={String} />
      {total !== null ? (
        <span className="hidden sm:inline">
          <Odometer
            value={roundFor(total, displayCurrency)}
            format={(n) => formatPrice(n, displayCurrency)}
          />
        </span>
      ) : null}
    </Button>
  )
}
