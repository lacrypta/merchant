"use client"

import { Search, X } from "lucide-react"
import * as React from "react"

import { Input } from "@/components/ui/input"
import { fold } from "@/lib/domain/slug"

/**
 * Filter the storefront menu without shipping the catalog twice.
 *
 * The product list is deliberately server-rendered — `ProductRow`'s docblock
 * spells out why: a client list would cross the whole `Product` for every row,
 * markdown description and unknown tags included. Re-rendering it here would
 * ALSO mean sending the data on top of the HTML the server already sent.
 *
 * So the rows stay where they are and this hides the ones that do not match,
 * with an injected stylesheet rather than by touching nodes React owns:
 *
 *   - matching runs in JS, through the same `fold()` the dashboard search uses,
 *     so "cafe" finds "Café" and accents never matter;
 *   - hiding is one `<style>` rule keyed on `data-d`, so the browser does the
 *     work and no per-row state exists to drift;
 *   - with JavaScript off the input never renders and every product is visible.
 *
 * What crosses the wire is one short string per product, not a Product.
 */

export interface SearchEntry {
  d: string
  /** Everything worth matching on: title, summary, SKU, category. */
  text: string
  /** The category section this row lives in. */
  cat: string
}

export function StorefrontSearch({ entries }: { entries: SearchEntry[] }) {
  const [query, setQuery] = React.useState("")

  // Folded once, not on every keystroke: a 300-product catalog would otherwise
  // re-normalise 300 strings per character typed.
  const haystack = React.useMemo(
    () => entries.map((e) => ({ ...e, text: fold(e.text) })),
    [entries]
  )

  const needle = fold(query)
  const active = needle.length > 0

  const { hiddenIds, hiddenCats, matches } = React.useMemo(() => {
    if (!active) {
      return { hiddenIds: [], hiddenCats: [], matches: entries.length }
    }

    // Every space-separated term must appear somewhere: "fernet coca" should
    // find "Fernet con Coca" even though that exact string never occurs.
    const terms = needle.split(/\s+/).filter(Boolean)
    const isMatch = (text: string) => terms.every((t) => text.includes(t))

    const hidden: string[] = []
    const liveCats = new Set<string>()
    let count = 0

    for (const e of haystack) {
      if (isMatch(e.text)) {
        count++
        liveCats.add(e.cat)
      } else {
        hidden.push(e.d)
      }
    }

    const cats = [...new Set(haystack.map((e) => e.cat))].filter(
      (c) => !liveCats.has(c)
    )
    return { hiddenIds: hidden, hiddenCats: cats, matches: count }
  }, [active, needle, haystack, entries.length])

  /**
   * `CSS.escape` is not optional here. A product's `d` comes off a relay and
   * any client can put anything in it — an unescaped value would break out of
   * the selector and take the rest of the stylesheet with it.
   */
  const css = React.useMemo(() => {
    if (!active) return ""
    const rules: string[] = []
    if (hiddenIds.length > 0) {
      rules.push(
        `${hiddenIds.map((d) => `[data-product=${CSS.escape(d)}]`).join(",")}{display:none}`
      )
    }
    if (hiddenCats.length > 0) {
      rules.push(
        `${hiddenCats.map((c) => `[data-group=${CSS.escape(c)}]`).join(",")}{display:none}`
      )
    }
    // The per-category tally counts the whole category, so it would contradict
    // a filtered list sitting right under it.
    rules.push("[data-group-count]{display:none}")
    return rules.join("")
  }, [active, hiddenIds, hiddenCats])

  return (
    <div className="mb-6 space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar en el menú"
          aria-label="Buscar productos"
          className="pl-9"
        />
        {active ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Limpiar búsqueda"
            className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* Screen readers get the count; sighted users see the list change. */}
      <p aria-live="polite" className="sr-only">
        {active
          ? `${matches} ${matches === 1 ? "producto" : "productos"} de ${entries.length}`
          : ""}
      </p>

      {active ? (
        <p className="text-xs text-muted-foreground">
          <span className="numeric">{matches}</span> de{" "}
          <span className="numeric">{entries.length}</span>
          {/* Agrees with the TOTAL, not the match count: "1 de 4 producto". */}
          {entries.length === 1 ? " producto" : " productos"}
        </p>
      ) : null}

      {active && matches === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-strong px-6 py-10 text-center">
          <p className="text-sm font-medium">Nada coincide con «{query}»</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Probá con otra palabra.
          </p>
        </div>
      ) : null}

      {css ? <style>{css}</style> : null}
    </div>
  )
}
