import { CatalogSkeleton } from "@/components/storefront/catalog-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The storefront's shape, before it has any content.
 *
 * These MIRROR `s/[handle]/page.tsx` — same container width, same paddings,
 * same avatar size, same chip heights, same two-column split. That is the whole
 * job: a skeleton whose measurements differ from what replaces it is worse than
 * no skeleton, because the page visibly jumps at the exact moment the visitor
 * starts reading it. The previous version was 1440px wide against a 1152px
 * page, with an 80px avatar where the real one is 56px, and drew a grid of
 * cards where the catalog is a list of rows.
 *
 * Both loading files import from here so there is one definition to keep in
 * step with the page instead of two that drift.
 */

/** Matches the sticky navbar the layout renders once it resolves. */
export function StorefrontNavbarSkeleton() {
  return (
    <div className="sticky top-0 z-40 h-16 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-app items-center px-4 md:px-8">
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
    </div>
  )
}

export function StorefrontHeaderSkeleton() {
  return (
    <header className="relative border-b border-border">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-6 md:px-8 md:py-8">
        {/* size-14 / md:size-16 — the same avatar, not a bigger one. */}
        <Skeleton className="size-14 shrink-0 rounded-full md:size-16" />

        <div className="min-w-0 flex-1 space-y-1.5">
          {/* text-h1 is 2rem with a line-height of 1. */}
          <Skeleton className="h-8 w-56 max-w-full rounded-lg" />

          {/* The chip row: npub, "Editar", and the two that stream in later.
              All h-7, like TickerChip. The `about` line is deliberately not
              drawn — plenty of merchants have none, and a skeleton line that
              vanishes is its own kind of jump. */}
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-7 w-44 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
          </div>
        </div>
      </div>
    </header>
  )
}

/**
 * The body: catalog column plus the docked cart.
 *
 * The cart column is reserved even though it is empty. It is `lg:w-80` in the
 * real page and always rendered — leaving it out here would draw the product
 * list full-width and then squeeze it by 20rem the moment the page arrives.
 */
export function StorefrontBodySkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <CatalogSkeleton />
        </div>

        <div
          aria-hidden
          className="hidden lg:sticky lg:top-20 lg:block lg:w-80 lg:shrink-0"
        >
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  )
}
