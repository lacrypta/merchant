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

/**
 * Is this relay in use at all? Unknown relays default to in-use.
 *
 * "Off" is BOTH flags down, not `read === false` — a relay set write-only in
 * Ajustes is still very much in use, and reporting it as off would invite the
 * merchant to switch it "on" and silently change what it does.
 */
export function isRelayEnabled(url: string, entries: readonly RelayEntry[]): boolean {
  const n = normalizeRelayUrl(url) ?? url
  const entry = entries.find((e) => e.url === n)
  return entry ? entry.read || entry.write : true
}

/**
 * May we READ from this relay? Distinct from `isRelayEnabled` on purpose: a
 * write-only relay is in use but must not be queried.
 */
function canRead(url: string, entries: readonly RelayEntry[]): boolean {
  const n = normalizeRelayUrl(url) ?? url
  const entry = entries.find((e) => e.url === n)
  return entry ? entry.read : true
}

/**
 * Stop using a relay entirely, or start again.
 *
 * Switching off clears reads AND writes: a relay you turned off must not keep
 * receiving the merchant's catalog. Ajustes → Relays keeps the fine-grained
 * Leer/Escribir pair; this one switch is the coarse "use it or don't".
 *
 * Switching back on restores the relay's DEFAULT write-ness rather than
 * whatever it was before, because the off state does not record it. The one
 * case where that matters is an indexer like purplepag.es, which rejects
 * product kinds outright — and `isReadOnlyByDefault` already keeps it
 * read-only. A relay the merchant had hand-set to read-only in Ajustes will
 * come back writable; that is the documented cost of a single switch.
 *
 * A relay not yet in the record gets materialised as a manual entry, so
 * switching off one of the defaults actually persists instead of silently
 * falling back to "unknown ⇒ in use" on the next read.
 */
export function setRelayEnabled(url: string, enabled: boolean): void {
  const n = normalizeRelayUrl(url) ?? url
  const next = enabled
    ? { read: true, write: !isReadOnlyByDefault(n) }
    : { read: false, write: false }
  const entries = read()

  if (entries.some((e) => e.url === n)) {
    write(entries.map((e) => (e.url === n ? { ...e, ...next } : e)))
    return
  }

  write([...entries, { url: n, ...next, source: "manual" as const }])
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
  const kept = urls.filter((u) => canRead(u, entries))
  return kept.length > 0 ? kept : [...urls]
}

/** Test seam. Never call from application code. */
export function __resetRelayPrefs(): void {
  cached = []
  cachedRaw = null
  listeners.clear()
}
