"use client"

import { useCart } from "@/components/cart/cart-provider"
import { discountEntries, type ProductCoupon } from "@/lib/domain/coupon"
import { formatPrice } from "@/lib/domain/price"

/**
 * Where a coupon product's price would be: what its coupon is taking off this
 * cart right now, or the coupon's name while it is not discounting anything —
 * a free Vaso that reads "ARS 0" says nothing about why anyone would add it.
 */
export function CouponPrice({ coupon }: { coupon: ProductCoupon }) {
  const { cart, priced } = useCart()
  const applied = priced?.productCoupons.some((c) => c.id === coupon.id) ?? false
  const off = applied ? discountEntries(cart.lines, coupon.benefit) : []

  return (
    <p className="numeric text-right text-sm font-semibold text-primary sm:text-base">
      {off.length > 0
        ? off.map((d) => `−${formatPrice(d.amount, d.currency)}`).join(" ")
        : coupon.name}
    </p>
  )
}
