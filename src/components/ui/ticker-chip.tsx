import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The small pill from lacrypta.ar's hero ("U$D 64.114,28 # 959.567", numbers
 * in lime). It's the visual language for RateTicker, RelayStatusChip,
 * PublishQueueChip and the storefront product count.
 *
 * NOT a Button variant, deliberately: cva applies the `variant` group before
 * the `size` group, so a `chip` variant carrying h-7 would be silently
 * overwritten by `size: 'default'`'s h-12.
 *
 * `numeric` (tabular figures) is on the base class — without it the ticker
 * digits jitter on every 60s rate refresh.
 */
type Tone = "neutral" | "success" | "warning" | "danger"

const tones: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted-foreground",
  success: "border-success/30 bg-success-bg text-success",
  warning: "border-warning/30 bg-warning-bg text-warning",
  danger: "border-danger/30 bg-danger-bg text-danger",
}

const chipBase =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium numeric"

function TickerChip({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      data-slot="ticker-chip"
      className={cn(chipBase, tones[tone], className)}
      {...props}
    />
  )
}

/** Interactive variant — relay status, publish queue. Real <button>, real focus ring. */
function TickerChipButton({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"button"> & { tone?: Tone }) {
  return (
    <button
      type="button"
      data-slot="ticker-chip-button"
      className={cn(
        chipBase,
        tones[tone],
        "tap-44 transition-colors hover:border-border-strong",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    />
  )
}

export { TickerChip, TickerChipButton, chipBase, type Tone }
