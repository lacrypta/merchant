import { KINDS } from "@/lib/domain/kinds"
import { isReadOnlyByDefault, normalizeRelayUrl } from "@/lib/nostr/relays"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * NIP-65 relay list (kind 10002).
 *
 * Tag shape is `["r", "<url>"]` with an optional third element of "read" or
 * "write". An OMITTED marker means BOTH — that default is the single most
 * commonly mis-implemented part of NIP-65, so it's handled explicitly here.
 */
export type RelayMode = "read" | "write" | "both"

export interface RelayEntry {
  url: string
  read: boolean
  write: boolean
  /** Where this entry came from — shown as a badge in Settings. */
  source: "nip65" | "default" | "manual"
}

export function parseRelayListEvent(e: SignedEvent): RelayEntry[] {
  if (e.kind !== KINDS.RELAY_LIST) return []

  const out: RelayEntry[] = []
  const seen = new Set<string>()

  for (const tag of e.tags) {
    if (tag[0] !== "r" || !tag[1]) continue
    const url = normalizeRelayUrl(tag[1])
    if (!url || seen.has(url)) continue
    seen.add(url)

    const marker = tag[2]?.trim().toLowerCase()
    out.push({
      url,
      // No marker at all means read AND write (NIP-65).
      read: marker !== "write",
      write: marker !== "read",
      source: "nip65",
    })
  }

  return out
}

export function buildRelayListEvent(
  entries: RelayEntry[],
  createdAt: number
): EventTemplate {
  const tags: string[][] = []

  for (const entry of entries) {
    if (!entry.read && !entry.write) continue // a no-op entry is just noise
    if (entry.read && entry.write) {
      tags.push(["r", entry.url]) // omitted marker == both
    } else {
      tags.push(["r", entry.url, entry.write ? "write" : "read"])
    }
  }

  return {
    kind: KINDS.RELAY_LIST,
    created_at: createdAt,
    content: "",
    tags,
  }
}

export function writeRelays(entries: RelayEntry[]): string[] {
  return entries.filter((e) => e.write).map((e) => e.url)
}

export function readRelays(entries: RelayEntry[]): string[] {
  return entries.filter((e) => e.read).map((e) => e.url)
}

/**
 * Merge a NIP-65 list over the defaults.
 *
 * The user's own list wins on conflicts; defaults fill in only what's missing,
 * so a merchant who deliberately dropped a relay doesn't get it silently
 * re-added on every load.
 */
export function mergeWithDefaults(
  nip65: RelayEntry[],
  defaults: readonly string[]
): RelayEntry[] {
  const byUrl = new Map<string, RelayEntry>()

  for (const url of defaults) {
    const n = normalizeRelayUrl(url)
    if (!n) continue
    byUrl.set(n, {
      url: n,
      read: true,
      // Indexer-only relays reject product kinds; see READ_ONLY_BY_DEFAULT.
      write: !isReadOnlyByDefault(n),
      source: "default",
    })
  }
  for (const entry of nip65) byUrl.set(entry.url, entry)

  return [...byUrl.values()]
}
