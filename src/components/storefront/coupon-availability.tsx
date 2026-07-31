import { Loader2, TicketPercent } from "lucide-react"

import { CouponField } from "@/components/checkout/coupon-field"
import { getStorefrontCoupons } from "@/lib/server/storefront-coupons"

/**
 * Whether this shop takes coupons, decided by its published announcement.
 *
 * Both of these render NOTHING when there is no announcement, and that is the
 * point. A coupon box on a storefront whose codes we do not hold can only ever
 * answer "cupón inexistente" — better to not offer it than to offer something
 * that always fails.
 */

/** The chip beside the merchant's name. Storefront only. */
export async function CouponChip({
  pubkey,
  relayHints,
}: {
  pubkey: string
  relayHints: readonly string[]
}) {
  const coupons = await getStorefrontCoupons(pubkey, relayHints)
  if (!coupons) return null

  return (
    <span className="enter-pop inline-flex h-7 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 text-xs text-primary">
      <TicketPercent className="size-3.5" aria-hidden />
      Acepta cupones
    </span>
  )
}

/** The input itself. Checkout only. */
export async function CouponSlot({
  pubkey,
  relayHints,
}: {
  pubkey: string
  relayHints: readonly string[]
}) {
  const coupons = await getStorefrontCoupons(pubkey, relayHints)
  if (!coupons) return null

  return (
    <div className="enter-pop">
      <CouponField />
    </div>
  )
}

/** Held while we ask the relays, so the row does not pop in from nothing. */
export function CouponSlotSkeleton() {
  return (
    <p
      aria-busy="true"
      aria-live="polite"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
      Viendo si esta tienda acepta cupones…
    </p>
  )
}
