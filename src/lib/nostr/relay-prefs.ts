"use client"

import * as React from "react"

import type { RelayEntry } from "@/lib/domain/relay-list"
import { isReadOnlyByDefault, normalizeRelayUrl } from "@/lib/nostr/relays"

/**
 * Which relays this browser is allowed to read from.
 *
 * Deliberately the SAME `mm:relays` record that Settings already owns, rather
 * than a second "disabled relays" list. Two independent places to switch a
 * relay off would eventually disagree, and then nobody could tell which one
 * was in effect. Turning a relay off here is exactly the Settings "Leer"
 * switch, reachable from wherever you noticed the problem.
 *
 * A module-level store because the relay panel lives in the navbar, above
 * every provider, and the storefront has no CatalogProvider at all.
 */
const RELAYS_KEY = "mm:relays"

/**
 * Cache keyed by the RAW stored string, not a "loaded once" flag.
 *
 * `useSyncExternalStore` tears if the snapshot returns a fresh array every
 * call, so the reference has to be stable while nothing changes — but caching
 * indefinitely means any write that bypasses `writeRelayEntries` (devtools,
 * a stray `localStorage.setItem`) leaves this module serving a stale answer
 * for the rest of the tab, with the panel and the actual reads disagreeing.
 * The `storage` event does not fire in the tab that wrote. Re-reading the key
 * and comparing strings gives both properties for the price of a synchronous
 * localStorage get.
 */
let cachedRaw: string | null = null
let cached: RelayEntry[] = []
const listeners = new Set<() => void>()

function read(): RelayEntry[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(RELAYS_KEY)
  } catch {
    raw = null
  }
  if (raw === cachedRaw) return cached

  cachedRaw = raw
  try {
    const parsed = raw ? (JSON.parse(raw) as RelayEntry[]) : []
    cached = Array.isArray(parsed) ? parsed : []
  } catch {
    cached = []
  }
  return cached
}

function write(entries: RelayEntry[]): void {
  const raw = JSON.stringify(entries)
  cached = entries
  cachedRaw = raw
  try {
    window.localStorage.setItem(RELAYS_KEY, raw)
  } catch {
    /* private mode — the choice lasts for this tab only */
  }
  for (const l of listeners) l()
}

/**
 * Replace the whole record — what the Settings screen saves.
 *
 * Exported so there is exactly ONE writer. Settings writing to localStorage
 * directly would leave this module's in-memory cache stale for the rest of
 * the tab, and the navbar panel would keep showing the previous state.
 */
export function writeRelayEntries(entries: RelayEntry[]): void {
  write(entries)
}

/** The current record, for non-React callers. */
export function readRelayEntries(): RelayEntry[] {
  if (typeof window === "undefined") return []
  return read()
}

/** Is this relay allowed for reads? Unknown relays default to allowed. */
export function isRelayEnabled(url: string, entries: readonly RelayEntry[]): boolean {
  const n = normalizeRelayUrl(url) ?? url
  const entry = entries.find((e) => e.url === n)
  return entry ? entry.read : true
}

/**
 * Turn a relay's reads on or off.
 *
 * A relay not yet in the record gets materialised as a manual entry, so
 * switching off one of the defaults actually persists instead of silently
 * falling back to "unknown ⇒ allowed" on the next read.
 */
export function setRelayEnabled(url: string, enabled: boolean): void {
  const n = normalizeRelayUrl(url) ?? url
  const entries = read()
  const existing = entries.find((e) => e.url === n)

  if (existing) {
    write(entries.map((e) => (e.url === n ? { ...e, read: enabled } : e)))
    return
  }

  write([
    ...entries,
    {
      url: n,
      read: enabled,
      // Publishing is a SEPARATE switch in Ajustes → Relays. Deriving it from
      // this one would quietly stop the merchant's catalog reaching a relay
      // they only wanted to stop reading from — and re-enabling would turn
      // writing back on for one they had deliberately set read-only.
      write: !isReadOnlyByDefault(n),
      source: "manual" as const,
    },
  ])
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab editing Settings should be reflected here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== RELAYS_KEY) return
    // No invalidation needed: `read()` compares against the stored string.
    fn()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener("storage", onStorage)
  }
}

const SERVER: RelayEntry[] = []

export function useRelayPrefs(): RelayEntry[] {
  return React.useSyncExternalStore(
    subscribe,
    read,
    // No localStorage on the server; an empty record means "all allowed",
    // which is what the server rendered with.
    () => SERVER
  )
}

/**
 * Filter a relay list down to the ones reads are allowed on.
 *
 * Safe to call from non-React code — it reads the same cache. NEVER returns
 * an empty list from a non-empty input: switching every relay off would
 * otherwise silently turn the app into an offline shell with no explanation,
 * so the last one stands.
 */
export function enabledRelays(urls: readonly string[]): string[] {
  if (typeof window === "undefined") return [...urls]
  const entries = read()
  const kept = urls.filter((u) => isRelayEnabled(u, entries))
  return kept.length > 0 ? kept : [...urls]
}

/** Test seam. Never call from application code. */
export function __resetRelayPrefs(): void {
  cached = []
  cachedRaw = null
  listeners.clear()
}
