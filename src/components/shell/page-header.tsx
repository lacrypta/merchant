import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  count,
  description,
  action,
  className,
}: {
  title: string
  count?: number
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-4 pb-6",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-h1">
          {title}
          {typeof count === "number" ? (
            <span className="numeric ml-2 align-middle text-base font-medium text-muted-foreground">
              {count}
            </span>
          ) : null}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
