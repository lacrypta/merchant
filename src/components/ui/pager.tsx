"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Prev/next paging for a long list.
 *
 * Deliberately not a numbered pager: every list that uses this is sorted
 * newest-first and read from the top, so "page 7" is a place nobody navigates
 * to on purpose. What the reader does need is to know there IS more, and where
 * they are — which is the line on the left.
 *
 * Renders nothing for a single page rather than a disabled pair of buttons,
 * which is chrome for a list that fits.
 */
export function Pager({
  page,
  pageCount,
  onPage,
  label,
  className,
}: {
  page: number
  pageCount: number
  onPage: (page: number) => void
  /** Names what is being paged, for the landmark. */
  label: string
  className?: string
}) {
  if (pageCount <= 1) return null

  return (
    <nav
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3",
        className
      )}
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Página <span className="numeric">{page}</span> de{" "}
        <span className="numeric">{pageCount}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden />
          Anterior
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Siguiente
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  )
}
