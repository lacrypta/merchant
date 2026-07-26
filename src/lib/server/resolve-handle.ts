import "server-only"

import { nip19 } from "nostr-tools"

import { looksLikeHandle } from "@/lib/domain/handle"
import { parseNip05, resolveNip05 } from "@/lib/server/nip05"

export interface ResolvedHandle {
  pubkey: string
  /** Relay hints from nprofile TLV or the NIP-05 `relays` map. */
  relayHints: string[]
  /** How we got here — drives whether the storefront shows a nip05 badge. */
  via: "npub" | "nprofile" | "nip05" | "hex"
  /** The nip05 address, only when it actually resolved. */
  nip05?: string
}

/**
 * Resolve any user-supplied handle to a pubkey.
 *
 * Accepts: npub1…, nprofile1…, user@domain, a bare domain (-> _@domain),
 * and raw 64-char hex.
 */
export async function resolveHandle(
  input: string
): Promise<ResolvedHandle | null> {
  const raw = input.trim().replace(/^nostr:/i, "")
  if (!raw) return null

  if (/^npub1[a-z0-9]+$/i.test(raw)) {
    try {
      const d = nip19.decode(raw)
      if (d.type === "npub") {
        return { pubkey: d.data, relayHints: [], via: "npub" }
      }
    } catch {
      return null
    }
    return null
  }

  if (/^nprofile1[a-z0-9]+$/i.test(raw)) {
    try {
      const d = nip19.decode(raw)
      if (d.type === "nprofile") {
        return {
          pubkey: d.data.pubkey,
          relayHints: d.data.relays ?? [],
          via: "nprofile",
        }
      }
    } catch {
      return null
    }
    return null
  }

  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return { pubkey: raw.toLowerCase(), relayHints: [], via: "hex" }
  }

  // user@domain, or a bare domain meaning _@domain
  if (parseNip05(raw)) {
    const result = await resolveNip05(raw)
    if (!result) return null
    return {
      pubkey: result.pubkey,
      relayHints: result.relays,
      via: "nip05",
      nip05: raw.includes("@") ? raw.toLowerCase() : `_@${raw.toLowerCase()}`,
    }
  }

  return null
}

/** Re-exported for server callers; the implementation is client-safe. */
export { looksLikeHandle }
