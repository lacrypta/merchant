import { Skeleton } from "@/components/ui/skeleton"

/**
 * Covers the window in which `s/[handle]/layout.tsx` is awaiting relays.
 *
 * Next composes `<Layout><Suspense fallback={<Loading/>}><Page/></Suspense></Layout>`,
 * so while the LAYOUT itself is suspended the page's own loading.tsx cannot
 * render — including the navbar, which the layout now owns. Without this file
 * the storefront shows a blank screen for the whole relay fan-out.
 */
export default function StorefrontRouteLoading() {
  return (
    <div aria-busy="true">
      <div className="sticky top-0 z-40 h-16 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-app items-center px-4 md:px-8">
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
      </div>

      <div className="border-b border-border">
        <div className="mx-auto flex w-full max-w-app flex-col items-center gap-5 px-4 py-12 md:flex-row md:px-8">
          <Skeleton className="size-20 shrink-0 rounded-full md:size-24" />
          <div className="w-full space-y-3">
            <Skeleton className="h-9 w-64 max-w-full rounded-lg" />
            <Skeleton className="h-6 w-44 rounded-full" />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-app px-4 py-10 md:px-8">
        <Skeleton className="mb-4 h-7 w-40 rounded-lg" />
        <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="aspect-[3/4] w-full rounded-xl" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
