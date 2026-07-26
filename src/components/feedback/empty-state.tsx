import { GridBackdrop } from "@/components/brand/grid-backdrop"
import { cn } from "@/lib/utils"

/**
 * The shared empty panel. Callers MUST distinguish "nothing exists yet" from
 * "nothing matched your filter" — conflating them is a classic bug, and the
 * copy for each is completely different.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed border-border-strong px-6 py-16 text-center",
        className
      )}
    >
      <GridBackdrop />
      <h2 className="text-h3">{title}</h2>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  )
}
