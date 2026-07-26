import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * La Crypta button.
 *
 * Deviates from stock shadcn in three ways, all deliberate:
 *  1. Fully rounded pill (`rounded-full`) at every size, with h-12/px-8/600
 *     as the default — lifted from lacrypta.ar's computed styles (48px tall,
 *     0 32px padding, font-weight 600, border-radius 9999px). Form inputs
 *     stay `rounded-lg` so roundness reads as an affordance, not a texture.
 *  2. Focus is an OUTLINE WITH OFFSET, not an inset ring. The offset is
 *     load-bearing: it lands the light ring on the page background (13.36:1)
 *     instead of on top of a lime button, where #D4D4D4 would be 1.17:1 and
 *     invisible. Corollary: never place a lime primary button on a lime or
 *     light surface — use the `focus-ring-inverse` utility there.
 *  3. `destructive` is a solid background (white on it is 9.60:1); a separate
 *     `danger` variant carries --danger text (7.16:1) for cases where the
 *     action reads as text. --destructive as TEXT is 1.98:1 and fails.
 *
 * Sizes below 44px (`sm`, `xs`, `icon-sm`, `icon-xs`) are allowed ONLY inside
 * a row that already presents a >=44px target, or on lg:-gated desktop-only
 * surfaces. Anywhere else add the `tap-44` utility.
 */
const buttonVariants = cva(
  [
    "group/button inline-flex shrink-0 items-center justify-center",
    "rounded-full border border-transparent bg-clip-padding",
    "font-semibold whitespace-nowrap select-none",
    "transition-[background-color,border-color,color,box-shadow] duration-150 ease-[var(--ease-brand)]",
    // Focus: rely on the global :focus-visible outline (2px, offset 2px).
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "active:not-aria-[haspopup]:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-40",
    "aria-disabled:pointer-events-none aria-disabled:opacity-40",
    "aria-invalid:border-danger",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 motion-safe:hover:glow-primary",
        secondary:
          "bg-secondary text-foreground hover:bg-surface-4 active:bg-surface-4 aria-expanded:bg-surface-4",
        outline:
          "border-border-strong bg-transparent text-foreground hover:bg-secondary aria-expanded:bg-secondary",
        ghost:
          "text-muted-foreground hover:bg-secondary hover:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground",
        // Solid destructive: --destructive-foreground on --destructive is 9.60:1.
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/85 focus-visible:outline-danger",
        // Text-forward danger: --danger is 7.16:1 on the page background.
        danger:
          "border-danger/40 bg-danger-bg text-danger hover:bg-danger/20 focus-visible:outline-danger",
        link: "h-auto rounded-sm px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-12 gap-2 px-8 text-sm",
        sm: "h-9 gap-1.5 px-5 text-sm",
        xs: "h-7 gap-1 px-3 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-14 gap-2 px-10 text-base",
        icon: "size-11", // 44px — WCAG 2.5.8 floor
        "icon-sm": "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-14",
      },
      fullWidth: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  fullWidth,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, fullWidth, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
