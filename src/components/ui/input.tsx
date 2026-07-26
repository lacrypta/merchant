import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Two brand-critical deviations from stock shadcn:
 *
 *  1. `border-border-strong` (#636363, 3.30:1), NOT `border-input`
 *     (#262626, 1.31:1). An input's border IS the control, so it must meet
 *     WCAG 1.4.11's 3:1 for non-text UI components. --border stays for
 *     decorative edges only.
 *  2. `text-base` below md. Not cosmetic: iOS Safari zooms the viewport on
 *     focus for any input under 16px, which wrecks sticky form footers.
 *     `md:text-sm` restores desktop density.
 *
 * Error state uses --danger (7.16:1), never --destructive (1.98:1 as text).
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-lg border border-border-strong bg-transparent px-4 py-2 text-base",
        "transition-[border-color,box-shadow] duration-150",
        "file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-muted-foreground",
        "hover:border-foreground/40",
        "focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-danger aria-invalid:focus-visible:outline-danger",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
