import { CartButton } from "@/components/cart/cart-button"
import { CartProvider } from "@/components/cart/cart-provider"
import { StorefrontChrome } from "@/components/cart/storefront-chrome"
import { RelayLogSeed } from "@/components/nostr/relay-log-seed"
import { SiteNavbar } from "@/components/shell/site-navbar"
import {
  getStorefront,
  toCatalogIndex,
  toMerchantSummary,
} from "@/lib/server/storefront"

/** Relay reads need Node (WebSocket), and the data is public — cache it. */
export const runtime = "nodejs"
export const revalidate = 60

/**
 * Owns the merchant identity for BOTH the catalog page and checkout.
 *
 * Putting it here rather than in each page means one relay fan-out for the
 * whole route (getStorefront is React-cached), and it means a client-side
 * navigation from the catalog to checkout does not remount the cart.
 *
 * Note this deliberately does NOT call notFound(): thrown from a layout it
 * would propagate past this segment's own not-found.tsx up to the root, which
 * has none, and the visitor would get Next's unstyled 404 instead of ours.
 * The page below throws it instead.
 */
export default async function StorefrontLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const data = await getStorefront(decodeURIComponent(handle))

  if (!data) {
    return (
      <>
        <SiteNavbar />
        {children}
      </>
    )
  }

  const merchant = toMerchantSummary(data.resolved, data.store)

  return (
    <CartProvider merchant={merchant} catalog={toCatalogIndex(data.store)}>
      {/* SiteNavbar is a Server Component rendered INSIDE a client provider:
          legal, because it arrives as an already-rendered `children` prop
          rather than an import. Its `extra` slot has existed unused since the
          navbar was written — this is what it was for. */}
      <SiteNavbar extra={<CartButton />} />
      <RelayLogSeed stats={data.store.relayLog} />
      {children}
      <StorefrontChrome />
    </CartProvider>
  )
}
