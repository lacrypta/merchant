import type { SignedEvent } from "@/lib/nostr/types"

/** Parsed kind-0 metadata. */
export interface NostrProfile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
}

/**
 * Blank profile fields are common in the wild — and "blank" includes
 * invisible characters, not just whitespace. Real kind-0 events carry things
 * like U+200E (LTR mark) as a display_name, which `.trim()` happily keeps,
 * leaving an empty-looking heading.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g

export function cleanField(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const cleaned = v.replace(INVISIBLE, "").trim()
  return cleaned.length > 0 ? cleaned : undefined
}

export function parseProfileEvent(e: SignedEvent): NostrProfile {
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(e.content)
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>
  } catch {
    // A malformed kind-0 still identifies a pubkey; degrade, don't throw.
  }

  return {
    pubkey: e.pubkey,
    name: cleanField(json.name),
    displayName: cleanField(json.display_name) ?? cleanField(json.displayName),
    about: cleanField(json.about),
    picture: cleanField(json.picture) ?? cleanField(json.image),
    banner: cleanField(json.banner),
    nip05: cleanField(json.nip05)?.toLowerCase(),
    lud16: cleanField(json.lud16),
    website: cleanField(json.website),
  }
}

/** Best available human label, falling back to a truncated npub. */
export function profileLabel(
  profile: NostrProfile | null,
  fallbackNpub: string
): string {
  return (
    profile?.displayName ??
    profile?.name ??
    `${fallbackNpub.slice(0, 9)}…${fallbackNpub.slice(-4)}`
  )
}

/** Up to two initials for the avatar fallback. */
export function initialsFor(label: string): string {
  const words = label.replace(/^npub1/, "").split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}
