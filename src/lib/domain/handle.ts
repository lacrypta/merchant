/**
 * Client-safe handle helpers.
 *
 * Deliberately separate from src/lib/server/resolve-handle.ts: that module is
 * `server-only` and pulls in undici + node:net, so importing it from a client
 * component breaks the browser bundle. Anything the browser needs lives here.
 */

/** NIP-05 local part is restricted to a-z0-9-_. ; `_` means the bare domain. */
export const NIP05_RE =
  /^(?:[a-z0-9\-_.]+@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

/** Cheap shape check so the landing can validate before navigating. */
export function looksLikeHandle(input: string): boolean {
  const raw = input.trim().replace(/^nostr:/i, "")
  if (!raw) return false
  return (
    /^npub1[a-z0-9]{20,}$/i.test(raw) ||
    /^nprofile1[a-z0-9]{20,}$/i.test(raw) ||
    /^[0-9a-f]{64}$/i.test(raw) ||
    NIP05_RE.test(raw)
  )
}
