"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { looksLikeHandle } from "@/lib/domain/handle"

/**
 * The public catalog lookup.
 *
 * Validates the SHAPE locally before navigating, so obviously-bad input gets
 * an instant inline message instead of a round trip and a 404 page. Actual
 * resolution (npub / nprofile / nip05 / bare domain) happens server-side.
 */
export function HandleSearchForm({ autoFocus }: { autoFocus?: boolean }) {
  const router = useRouter()
  const [value, setValue] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const handle = value.trim().replace(/^nostr:/i, "")

    if (!handle) {
      setError("Escribí un npub o un NIP-05.")
      return
    }
    if (!looksLikeHandle(handle)) {
      setError("No parece un npub ni un NIP-05.")
      return
    }

    setError(null)
    setPending(true)
    router.push(`/s/${encodeURIComponent(handle)}`)
  }

  return (
    <form onSubmit={onSubmit} noValidate className="w-full">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (error) setError(null)
            }}
            autoFocus={autoFocus}
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            aria-label="npub o NIP-05 del comercio"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "handle-error" : undefined}
            placeholder="npub1… o pepe@lacrypta.ar"
            className="h-14 rounded-full pr-5 pl-12 text-base"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Buscando…" : "Ver tienda"}
        </Button>
      </div>

      {error ? (
        <p id="handle-error" role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  )
}
