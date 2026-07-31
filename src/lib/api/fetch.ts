"use client"

import { ApiError } from "@/lib/api/error"
import { getSessionToken, invalidateSession } from "@/lib/api/session"
import type { SignerPort } from "@/lib/nostr/types"

/**
 * Every call to our own API, carrying the session bearer.
 *
 * `pubkey` is passed in rather than asked of the signer: on NIP-46 that is a
 * round trip, the caller always has it from `useAuth().state`, and it makes the
 * account-switch check in session.ts compare against who the UI believes is
 * logged in.
 */
export async function apiFetch<T>(
  signer: SignerPort,
  pubkey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = init.method ?? "GET"
  const url = new URL(path, window.location.origin).toString()
  // Stringified once: the same bytes are sent and, on the NIP-98 path, hashed.
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)

  async function send(token: string): Promise<{
    res: Response
    data: (T & { error?: string; reason?: string }) | null
  }> {
    const res = await fetch(url, {
      method,
      body,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
    })
    // Parsed on every attempt, including the 401: `reason` decides nothing
    // here, but a failing retry still has to surface the server's message.
    const data = (await res.json().catch(() => null)) as
      | (T & { error?: string; reason?: string })
      | null
    return { res, data }
  }

  const token = await getSessionToken(signer, pubkey)
  let { res, data } = await send(token)

  /**
   * Exactly one retry, on ANY 401 — never a loop, because the second 401 falls
   * through to the throw below.
   *
   * Deliberately not conditioned on `reason === "session-expired"`. When the
   * deployment has no SESSION_JWT_SECRET the key is random per process, so a
   * restart makes every live token fail as `session-invalid` instead; branching
   * on the reason would show an error in every open tab on every deploy.
   */
  if (res.status === 401) {
    invalidateSession(pubkey, token)
    ;({ res, data } = await send(await getSessionToken(signer, pubkey)))
  }

  if (!res.ok) {
    throw new ApiError(data?.error ?? "Algo salió mal. Probá de nuevo.", res.status, data?.reason)
  }
  return data as T
}
