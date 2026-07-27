"use client"

import { useIsFetching } from "@tanstack/react-query"
import { Check, RefreshCw } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * "You are looking at cached data, and it is being checked right now."
 *
 * Local-first has one honesty problem: the screen fills instantly, so a
 * visitor cannot tell a fresh catalog from a week-old one. This is the answer
 * — a small, permanently-available indicator rather than a blocking spinner,
 * because the whole point is that nothing blocks.
 *
 * Deliberately slow to appear and slow to leave: a 400ms delay means the
 * common case (a warm 80ms refetch) never flickers a badge at anyone, and a
 * brief "al día" confirmation on the way out is what turns a spinner
 * disappearing into an answer.
 */
export function SyncBadge({ className }: { className?: string }) {
  const fetching = useIsFetching()
  const [phase, setPhase] = React.useState<"idle" | "syncing" | "done">("idle")

  /** Did we ever actually show the spinner for this burst of fetching? */
  const announced = React.useRef(false)

  React.useEffect(() => {
    // Every setState below is inside a timer callback, never in the effect
    // body: a synchronous one cascades a render, and the lint rule that
    // forbids it is right.
    let show: number | undefined
    let hide: number | undefined

    if (fetching > 0) {
      show = window.setTimeout(() => {
        announced.current = true
        setPhase("syncing")
      }, 400)
    } else if (announced.current) {
      // Only claim "up to date" if we actually said we were working —
      // otherwise an idle page load flashes a checkmark at nobody.
      announced.current = false
      show = window.setTimeout(() => setPhase("done"), 0)
      hide = window.setTimeout(() => setPhase("idle"), 1600)
    } else {
      show = window.setTimeout(() => setPhase("idle"), 0)
    }

    return () => {
      if (show) window.clearTimeout(show)
      if (hide) window.clearTimeout(hide)
    }
  }, [fetching])

  return (
    <span
      aria-live="polite"
      className={cn(
        "pointer-events-none inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-full border px-0 text-xs font-medium",
        "transition-[opacity,transform,padding,border-color,color] duration-300 ease-[var(--ease-brand)]",
        phase === "idle" && "scale-95 border-transparent px-0 opacity-0",
        phase === "syncing" && "border-border-strong px-3 text-muted-foreground opacity-100",
        phase === "done" && "border-success/30 px-3 text-success opacity-100",
        className
      )}
    >
      {phase === "done" ? (
        <>
          <Check className="size-3 shrink-0" aria-hidden />
          <span className="whitespace-nowrap">Al día</span>
        </>
      ) : (
        <>
          <RefreshCw
            className="size-3 shrink-0 motion-safe:animate-spin"
            aria-hidden
          />
          <span className="whitespace-nowrap">Actualizando…</span>
        </>
      )}
    </span>
  )
}
