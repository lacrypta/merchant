"use client"

import { Check, Copy } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Copy a short string, and say so.
 *
 * One component because there were three, and all three got the guard wrong in
 * the same way: `navigator.clipboard?.writeText(v).then(...)` short-circuits to
 * `undefined` when the API is missing — on any non-secure origin, which
 * includes a phone hitting the dev server over LAN — and then calls `.then` on
 * it. The optional chain was doing the opposite of protecting the call.
 *
 * So: the whole chain is awaited inside a try, "Copiado" only appears once the
 * write actually resolved, and the reset timer is cleared on unmount.
 */
export function CopyButton({
  value,
  label,
  showLabel = false,
  className,
}: {
  value: string
  /** What is being copied, e.g. "Copiar el nonce" — the accessible name. */
  label: string
  /** Print the label next to the icon instead of hiding it in `aria-label`. */
  showLabel?: boolean
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
    } catch {
      // A denied permission or a missing API is not worth interrupting anyone
      // over: the value is on screen and selectable either way.
    }
  }

  const Icon = copied ? Check : Copy

  if (showLabel) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => void copy()}
      >
        <Icon className="size-4" aria-hidden />
        {copied ? "Copiado" : label}
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      className={cn("size-6 shrink-0 text-muted-foreground", className)}
      onClick={() => void copy()}
    >
      <Icon className={cn("size-3.5", copied && "text-success")} aria-hidden />
    </Button>
  )
}
