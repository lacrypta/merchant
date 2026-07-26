import { cn } from "@/lib/utils"

/**
 * The lime grid texture from lacrypta.ar.
 *
 * Always absolutely positioned and pointer-events-none — never wrap content
 * in it. `horizon` applies the hero's perspective skew and is flattened
 * under prefers-reduced-motion (a large skewed texture is a vestibular
 * trigger); `flat` is the calmer variant for panels and empty states.
 */
export function GridBackdrop({
  variant = "flat",
  className,
}: {
  variant?: "flat" | "horizon"
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10",
        variant === "flat" ? "grid-flat" : "grid-horizon",
        className
      )}
    />
  )
}
