import { Skeleton } from "@/components/ui/skeleton"

export default function StorefrontLoading() {
  return (
    <>
      <main id="main" className="flex-1" aria-busy="true">
        <header className="border-b border-border">
          <div className="mx-auto flex w-full max-w-app flex-col items-center gap-4 px-4 py-12 md:flex-row md:items-end md:px-8">
            <Skeleton className="size-20 rounded-full md:size-24" />
            <div className="w-full flex-1 space-y-3">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-6 w-40" />
            </div>
          </div>
        </header>
        <div className="mx-auto w-full max-w-app px-4 py-10 md:px-8">
          <Skeleton className="mb-4 h-8 w-40" />
          {/* Shaped like the list it becomes, so the layout does not jump when
              the real rows arrive. */}
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
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
      </main>
    </>
  )
}
