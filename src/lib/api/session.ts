"use client"

import { ApiError } from "@/lib/api/error"
import { nowSeconds } from "@/lib/nostr/created-at"
import { createNip98Token } from "@/lib/nostr/nip98"
import type { SignerPort } from "@/lib/nostr/types"

/**
 * One signature per session instead of one per request.
 *
 * The merchant signs a NIP-98 event once, /api/auth/session hands back a bearer
 * token, and every later call carries that. On a NIP-46 bunker each signature
 * is a round trip and a tap on a phone, so editing three coupons used to be six
 * authorisations.
 *
 * IN sessionStorage, NOT localStorage: the token dies with the tab, which caps
 * how long a stolen one is worth anything far below its twelve-hour expiry. The
 * price is that two tabs are two sessions and therefore two signatures — a
 * property of the choice, not a bug.
 *
 * THE CLIENT NEVER DECODES THE TOKEN. `pubkey` and `expiresAt` come from the
 * server's response body; reading them out of the JWT would mean trusting a
 * claim the browser cannot verify.
 */

const KEY = "mm:api-token"
/** Do not send a token that dies mid-flight: the 401 costs a round trip. */
const SKEW_SECONDS = 60

interface StoredSession {
  token: string
  pubkey: string
  expiresAt: number
}

function readRaw(): StoredSession | null {
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(KEY)
  } catch {
    // Private mode, or storage disabled. No session; sign per request.
    return null
  }
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as StoredSession).token !== "string" ||
      typeof (parsed as StoredSession).pubkey !== "string" ||
      typeof (parsed as StoredSession).expiresAt !== "number"
    ) {
      return null
    }
    return parsed as StoredSession
  } catch {
    return null
  }
}

function write(session: StoredSession): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    // Quota or private mode: the token still works for this page's lifetime,
    // it just will not survive a reload.
  }
}

function remove(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    /* nothing to do, and nothing to tell the merchant */
  }
}

/**
 * The stored token, if it is this account's and still worth sending.
 *
 * The pubkey comparison is the account-switch detector: it holds what the
 * SERVER said it minted for, against who the UI currently thinks is logged in.
 * A merchant who switches accounts in their extension without logging out gets
 * a fresh token rather than 401s they cannot explain.
 */
function readStored(pubkey: string, now: number): StoredSession | null {
  const stored = readRaw()
  if (!stored) return null
  if (stored.pubkey !== pubkey || stored.expiresAt - now < SKEW_SECONDS) {
    remove()
    return null
  }
  return stored
}

let inFlight: { pubkey: string; promise: Promise<string> } | null = null

/**
 * Bumped by clearApiSession. A mint that started before a logout must not
 * write its result afterwards — a bunker prompt approved on a phone three
 * seconds after "Cerrar sesión" would otherwise restore the old account.
 */
let epoch = 0

async function mint(signer: SignerPort, pubkey: string): Promise<string> {
  const mintedIn = epoch
  const url = new URL("/api/auth/session", window.location.origin).toString()

  let authorization: string
  try {
    authorization = await createNip98Token(signer, url, "POST")
  } catch (e) {
    // A bunker that refuses kind 27235 lands here. Sessions connected before
    // this kind was added to SIGNING_KINDS have to reconnect once.
    throw new ApiError(
      e instanceof Error && /denied|reject/i.test(e.message)
        ? "Tu firmante rechazó la autorización. Si usás un bunker, volvé a conectarlo."
        : "No pudimos firmar la autorización. Probá de nuevo.",
      0
    )
  }

  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { authorization },
  })
  const data = (await res.json().catch(() => null)) as
    | (StoredSession & { error?: string })
    | null

  if (!res.ok || !data?.token) {
    throw new ApiError(data?.error ?? "No pudimos iniciar la sesión.", res.status)
  }

  if (epoch !== mintedIn) {
    throw new ApiError("La sesión se cerró.", 0)
  }

  /**
   * The server minted for whoever actually signed, which is not always who the
   * UI thinks is logged in: an extension can switch accounts between the render
   * that read the pubkey and the prompt the merchant approved. Storing it under
   * the wrong expectation would make `readStored` reject it every single time —
   * a fresh signature, and a fresh popup, on every request.
   */
  if (data.pubkey !== pubkey) {
    throw new ApiError(
      "Tu firmante autorizó con otra cuenta. Volvé a entrar con la que querés usar.",
      0
    )
  }

  const session: StoredSession = {
    token: data.token,
    pubkey: data.pubkey,
    expiresAt: data.expiresAt,
  }
  write(session)
  return session.token
}

/**
 * The session token, minting one if there is none.
 *
 * Concurrent callers share a single in-flight mint, keyed by pubkey: five
 * mutations firing after an expiry cost ONE signature, not five. Keyed rather
 * than a bare promise so a mint started for account A is never handed to a
 * caller that has since switched to B.
 *
 * No negative caching. A refused bunker prompt is usually somebody tapping the
 * wrong thing, and a cooldown would make "click it again" not work.
 */
export async function getSessionToken(signer: SignerPort, pubkey: string): Promise<string> {
  const stored = readStored(pubkey, nowSeconds())
  if (stored) return stored.token

  if (inFlight?.pubkey === pubkey) return inFlight.promise

  const promise = mint(signer, pubkey).finally(() => {
    // Guarded: a newer mint may already have replaced this entry.
    if (inFlight?.promise === promise) inFlight = null
  })
  inFlight = { pubkey, promise }
  return promise
}

/**
 * Drop a token the server just refused — but only if it is still the one
 * stored.
 *
 * The second argument is what makes a burst of parallel requests cost one
 * signature instead of two. Say five mutations are in flight when the token
 * expires: the first 401 mints T2 and stores it, and the second 401 arrives
 * afterwards. Clearing unconditionally would throw away a perfectly good T2 and
 * prompt the merchant again for nothing.
 */
export function invalidateSession(pubkey: string, staleToken: string): void {
  const stored = readRaw()
  if (stored?.pubkey === pubkey && stored.token === staleToken) remove()
}

/** Sign out: forget the token and disown any mint still in the air. */
export function clearApiSession(): void {
  epoch += 1
  inFlight = null
  remove()
}
