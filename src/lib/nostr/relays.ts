/**
 * Default relay set.
 *
 * NOTE: wss://relay.lacrypta.ar is included because lawalletio/pos points
 * there, but as of 2026-07-25 it returns Cloudflare error 1033 (tunnel down).
 * Connection to it must always be best-effort — never block startup, a query,
 * or a publish confirmation on it.
 */
export const DEFAULT_RELAYS = [
  "wss://relay.lacrypta.ar",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
] as const

/**
 * Relays that must never be in the WRITE set by default.
 *
 * purplepag.es is a profile / relay-list indexer and rejects product events
 * outright — observed verbatim: `blocked: kind 30402 is not allowed`. Leaving
 * it writable makes every single publish report a failure the merchant can do
 * nothing about, which trains them to ignore the partial-publish warning.
 * It stays in the READ set, where it is genuinely the best source for kind-0
 * and kind-10002.
 */
export const READ_ONLY_BY_DEFAULT: readonly string[] = ["wss://purplepag.es"]

export function isReadOnlyByDefault(url: string): boolean {
  const n = normalizeRelayUrl(url)
  return n !== null && READ_ONLY_BY_DEFAULT.includes(n)
}

/** The de-facto kind:0 / kind:10002 indexer — good for profile lookups. */
export const LOOKUP_RELAYS = ["wss://purplepag.es", "wss://relay.nostr.band"] as const

/** Normalise for de-duplication: lowercase host, no trailing slash. */
export function normalizeRelayUrl(url: string): string | null {
  let raw = url.trim()
  if (!raw) return null
  if (!/^wss?:\/\//i.test(raw)) raw = `wss://${raw}`

  try {
    const u = new URL(raw)
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return null
    u.hash = ""
    u.search = ""
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "")
    return `${u.protocol}//${u.host.toLowerCase()}${path}`
  } catch {
    return null
  }
}

export function dedupeRelays(urls: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const u of urls) {
    const n = normalizeRelayUrl(u)
    if (n) seen.add(n)
  }
  return [...seen]
}
