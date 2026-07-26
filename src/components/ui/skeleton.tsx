import { cn } from "@/lib/utils"

/**
 * `bg-surface-3` rather than shadcn's `bg-muted` — #262626 is barely visible
 * against the #0A0A0A page. `motion-safe:` so the pulse respects
 * prefers-reduced-motion (the global media query is a backstop, not the only
 * defence). aria-hidden because a skeleton is decoration; the container that
 * owns it should carry aria-busy.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("motion-safe:animate-pulse rounded-md bg-surface-3", className)}
      {...props}
    />
  )
}

export { Skeleton }
