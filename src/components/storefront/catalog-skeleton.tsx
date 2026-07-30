import { Loader2 } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"

/**
 * What the visitor looks at while the catalog streams in.
 *
 * Shaped like the list it becomes — same row height, same columns — so nothing
 * jumps when the real products replace it. The line above it says what is
 * actually happening: "cargando" is a spinner, "buscando en los relays" is an
 * explanation, and on a slow relay that difference is the whole experience.
 */
export function CatalogSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        Buscando productos en los relays…
      </p>

      <Skeleton className="mb-3 h-7 w-40" />

      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
            // Staggered so it reads as a list filling in rather than one block
            // pulsing. Cheap: it is the same animation, offset.
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <Skeleton className="size-14 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-16 shrink-0" />
            <Skeleton className="size-11 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
