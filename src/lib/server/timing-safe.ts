import "server-only"

/**
 * Compare two ASCII strings without leaking where they diverge.
 *
 * Shared by the two things here that hold a MAC up against a recomputed one —
 * the LNURL handles in signed-url.ts and the session tokens in
 * session-token.ts. The window either of them leaks is tiny, but a second copy
 * of a comparison primitive is how one of the copies ends up with an early
 * `return false` inside the loop.
 *
 * Only safe for hex and base64url, where every character is one code unit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
