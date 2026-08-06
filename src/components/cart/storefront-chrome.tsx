"use client"

import type * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { CartPanel } from "@/components/cart/cart-panel"
import { MobileCartBar } from "@/components/cart/mobile-cart-bar"

/**
 * The cart surfaces that live outside the page content: the drawer/dialog and
 * the sticky mobile summary bar.
 *
 * Separate from CartProvider so the provider stays a pure state container and
 * can be rendered by a Server Component without dragging the whole cart UI
 * into that module's client boundary.
 */
export function StorefrontChrome({
  /** Server-rendered coupon input, for the drawer's copy of the cart. */
  couponSlot,
}: {
  couponSlot?: React.ReactNode
}) {
  const { count, hydrated } = useCart()
  const showBar = hydrated && count > 0

  return (
    <>
      <CartPanel couponSlot={couponSlot} />
      <MobileCartBar />
      {/*
        `.safe-b` pads the BAR's own bottom for the home indicator; it does
        nothing for the content underneath. Without this spacer the last row
        of the grid and the "buscar otra tienda" footer sit behind the bar.
      */}
      {showBar ? <div aria-hidden className="safe-b h-20 lg:hidden" /> : null}
    </>
  )
}
