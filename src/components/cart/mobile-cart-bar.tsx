"use client"

import { Zap } from "lucide-react"
import { useRouter } from "next/navigation"

import { useCart } from "@/components/cart/cart-provider"
import { roundFor } from "@/components/cart/money"
import { Button } from "@/components/ui/button"
import { Odometer } from "@/components/ui/odometer"
import { formatPrice } from "@/lib/domain/price"
import { fromSats } from "@/lib/domain/rates"

/**
 * The sticky summary on phones — the POS affordance.
 *
 * z-40, the same layer as SiteNavbar: one is pinned to the top and the other
 * to the bottom, so they can never overlap, and both stay below the modal
 * layer at z-50 so the cart's own overlay dims this bar rather than fighting
 * it.
 */
export function MobileCartBar() {
  const {
    merchant,
    count,
    hydrated,
    quote,
    rates,
    displayCurrency,
    setPanelOpen,
  } = useCart()
  const router = useRouter()

  if (!hydrated || count === 0) return null

  const total =
    quote && rates ? fromSats(quote.exactSats, displayCurrency, rates) : null
  const canPay = merchant.canCheckout && !!quote && quote.unquotable.length === 0

  return (
    <div className="enter-row safe-b fixed inset-x-0 bottom-0 z-40 border-t border-border bg-popover/95 px-4 py-3 backdrop-blur lg:hidden">
      <div className="mx-auto flex w-full max-w-app items-center gap-3">
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block text-xs text-muted-foreground">
            <Odometer value={count} format={String} />{" "}
            {count === 1 ? "producto" : "productos"} · Ver pedido
          </span>
          {total !== null ? (
            <span className="text-price block leading-tight">
              <Odometer
                value={roundFor(total, displayCurrency)}
                format={(n) => formatPrice(n, displayCurrency)}
              />
            </span>
          ) : null}
        </button>

        <Button
          disabled={!canPay}
          onClick={() => router.push(`/s/${merchant.npub}/checkout`)}
        >
          <Zap className="size-4" aria-hidden />
          Pagar
        </Button>
      </div>
    </div>
  )
}
