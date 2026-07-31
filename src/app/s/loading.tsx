import {
  StorefrontBodySkeleton,
  StorefrontHeaderSkeleton,
  StorefrontNavbarSkeleton,
} from "@/components/storefront/storefront-skeleton"

/**
 * Covers the window in which `s/[handle]/layout.tsx` is awaiting relays.
 *
 * Next composes `<Layout><Suspense fallback={<Loading/>}><Page/></Suspense></Layout>`,
 * so while the LAYOUT itself is suspended the page's own loading.tsx cannot
 * render — including the navbar, which the layout owns. Without this file the
 * storefront shows a blank screen for that whole wait.
 *
 * The navbar is the only thing this draws that `[handle]/loading.tsx` does not.
 */
export default function StorefrontRouteLoading() {
  return (
    <div aria-busy="true">
      <StorefrontNavbarSkeleton />
      <StorefrontHeaderSkeleton />
      <StorefrontBodySkeleton />
    </div>
  )
}
