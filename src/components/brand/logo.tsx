import { cn } from "@/lib/utils"

/**
 * La Crypta isologo — the arched "crypt" mark.
 * Redrawn as inline SVG so it inherits currentColor and needs no network
 * request. Reference: github.com/lacrypta/branding.
 */
export function LaCryptaMark({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("size-7", className)}
      {...props}
    >
      {/* Arch: flat base, semicircular top */}
      <path
        d="M8 60V28a24 24 0 0 1 48 0v32z"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path
        d="M8 60V28a24 24 0 0 1 48 0v32"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Ledger lines */}
      <path
        d="M22 34h20M22 44h20"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LaCryptaMark className="size-7 text-primary" />
      {showWordmark ? (
        <span className="text-h3 leading-none font-bold tracking-tight">
          merchant
        </span>
      ) : null}
    </span>
  )
}
