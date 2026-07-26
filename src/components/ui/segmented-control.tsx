"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/**
 * Pill segmented control — the brand's single-choice affordance.
 *
 * Used for: currency (ARS/USD/SAT), product status filter, visibility,
 * POS preview mode, default currency, language. Six-ish places, so it earns
 * its own component rather than being re-styled inline each time.
 *
 * Built on Radix ToggleGroup (`type="single"`), which supplies roving
 * tabindex and arrow-key navigation for free — do not hand-roll either.
 *
 * Active state is lime on near-black (14.15:1). Items are h-9 inside an
 * h-11 track; the whole control clears 44px, so individual items don't
 * need `tap-44`.
 */

type SegmentedControlOption<T extends string> = {
  value: T
  label: React.ReactNode
  /** Optional per-item accent, e.g. the currency tokens. Chip-only usage. */
  className?: string
  disabled?: boolean
  "aria-label"?: string
}

type SegmentedControlProps<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedControlOption<T>[]
  className?: string
  itemClassName?: string
  /** Fill the available width — used on mobile where segments span the row. */
  fullWidth?: boolean
  "aria-label"?: string
}

function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  itemClassName,
  fullWidth,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix emits "" when the active item is re-clicked; ignore it so the
      // control can never enter an empty state.
      onValueChange={(next) => {
        if (next) onValueChange(next as T)
      }}
      className={cn(
        "inline-flex h-11 items-center gap-1 rounded-full border border-border bg-secondary p-1",
        fullWidth && "flex w-full",
        className
      )}
      {...props}
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          aria-label={opt["aria-label"]}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-5",
            "text-sm font-semibold text-muted-foreground transition-colors",
            "hover:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
            "disabled:pointer-events-none disabled:opacity-40",
            fullWidth && "flex-1",
            itemClassName,
            opt.className
          )}
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export { SegmentedControl, type SegmentedControlOption }
