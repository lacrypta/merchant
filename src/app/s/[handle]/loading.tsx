import { SiteNavbar } from "@/components/shell/site-navbar"
import { Skeleton } from "@/components/ui/skeleton"

export default function StorefrontLoading() {
  return (
    <>
      <SiteNavbar />
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
          <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />
            ))}
          </div>
        </div>
      </main>
    </>
  )
}
