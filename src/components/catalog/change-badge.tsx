import { CHANGE_LABEL, type ChangeKind } from "@/lib/domain/catalog-diff"
import { cn } from "@/lib/utils"

/**
 * Marks one entity as differing from what is published.
 *
 * Tone carries meaning here, so each state also carries its own word — colour
 * is never the only signal.
 */
const TONE: Record<ChangeKind, string> = {
  new: "border-success/30 bg-success-bg text-success",
  modified: "border-warning/30 bg-warning-bg text-warning",
  deleted: "border-danger/40 bg-danger-bg text-danger",
}

export function ChangeBadge({
  kind,
  className,
}: {
  kind: ChangeKind | undefined
  className?: string
}) {
  if (!kind) return null
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[0.6875rem] font-medium",
        TONE[kind],
        className
      )}
    >
      {CHANGE_LABEL[kind]}
    </span>
  )
}
