import {
  StorefrontBodySkeleton,
  StorefrontHeaderSkeleton,
} from "@/components/storefront/storefront-skeleton"

/**
 * The page's own wait, inside a layout that has already rendered — so no
 * navbar here, the real one is above.
 *
 * Short-lived now: the page awaits the same merchant lookup the layout just
 * did, and `cache()` makes that a hit. The catalog and the coupon announcement
 * have their own Suspense boundaries inside the page and keep streaming after
 * this is gone.
 */
export default function StorefrontLoading() {
  return (
    <main id="main" className="flex-1" aria-busy="true">
      <StorefrontHeaderSkeleton />
      <StorefrontBodySkeleton />
    </main>
  )
}
