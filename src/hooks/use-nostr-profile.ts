"use client"

import * as React from "react"

import { KINDS } from "@/lib/domain/kinds"
import { parseProfileEvent, type NostrProfile } from "@/lib/domain/profile"
import { queryEvents } from "@/lib/nostr/backend"
import { LOOKUP_RELAYS, dedupeRelays, DEFAULT_RELAYS } from "@/lib/nostr/relays"

/**
 * NIP-05 verification state.
 *
 * NIP-05 is IDENTIFICATION, NOT VERIFICATION: a kind-0 can claim any address.
 * The claim only means something once the domain's /.well-known/nostr.json
 * maps that name back to this exact pubkey — so the UI must never show a
 * check mark on `unverified`, only on `verified`.
 */
export type Nip05State = "none" | "checking" | "verified" | "mismatch" | "unreachable"

export interface ProfileResult {
  profile: NostrProfile | null
  loading: boolean
  nip05State: Nip05State
}

/**
 * Shared across components so N avatars for one pubkey cost one query.
 *
 * ONLY successful lookups are cached. Caching a miss would mean one slow
 * relay round-trip pins that npub to its initials for the rest of the
 * session — and "no profile" is very often just "no answer yet".
 * `inflight` collapses concurrent callers onto a single query instead.
 */
const profileCache = new Map<string, NostrProfile>()
const inflight = new Map<string, Promise<NostrProfile | null>>()
const nip05Cache = new Map<string, Nip05State>()

async function fetchProfile(pubkey: string): Promise<NostrProfile | null> {
  const cached = profileCache.get(pubkey)
  if (cached) return cached

  const existing = inflight.get(pubkey)
  if (existing) return existing

  const promise = (async () => {
    // purplepag.es first: it is the de-facto kind-0 indexer and answers far
    // more reliably than general-purpose relays for metadata.
    const relays = dedupeRelays([...LOOKUP_RELAYS, ...DEFAULT_RELAYS])
    const events = await queryEvents(
      [{ kinds: [KINDS.METADATA], authors: [pubkey] }],
      relays,
      { timeoutMs: 8_000 }
    )
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return null
    const parsed = parseProfileEvent(newest)
    profileCache.set(pubkey, parsed)
    return parsed
  })().finally(() => inflight.delete(pubkey))

  inflight.set(pubkey, promise)
  return promise
}

export function useNostrProfile(pubkey: string | null): ProfileResult {
  const [profile, setProfile] = React.useState<NostrProfile | null>(() =>
    pubkey ? (profileCache.get(pubkey) ?? null) : null
  )
  const [loading, setLoading] = React.useState(
    () => !!pubkey && !profileCache.has(pubkey)
  )
  const [nip05State, setNip05State] = React.useState<Nip05State>(() =>
    pubkey ? (nip05Cache.get(pubkey) ?? "none") : "none"
  )

  React.useEffect(() => {
    let cancelled = false

    // Everything runs inside the async IIFE, including the no-pubkey reset:
    // a synchronous setState in an effect body cascades a render.
    void (async () => {
      if (!pubkey) {
        if (cancelled) return
        setProfile(null)
        setLoading(false)
        setNip05State("none")
        return
      }

      if (!profileCache.has(pubkey)) setLoading(true)
      const found = await fetchProfile(pubkey)
      if (cancelled) return
      setProfile(found)
      setLoading(false)

      const claimed = found?.nip05
      if (!claimed) {
        setNip05State("none")
        return
      }

      const known = nip05Cache.get(pubkey)
      if (known) {
        setNip05State(known)
        return
      }

      setNip05State("checking")
      try {
        const res = await fetch(
          `/api/nip05?address=${encodeURIComponent(claimed)}`,
          { cache: "no-store" }
        )
        const data = (await res.json()) as { pubkey?: string | null }
        // A claim only counts once the DOMAIN maps it back to this exact
        // pubkey. Anything else is shown without a check mark.
        const state: Nip05State = !res.ok
          ? "unreachable"
          : data.pubkey?.toLowerCase() === pubkey.toLowerCase()
            ? "verified"
            : "mismatch"
        nip05Cache.set(pubkey, state)
        if (!cancelled) setNip05State(state)
      } catch {
        if (!cancelled) setNip05State("unreachable")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pubkey])

  return { profile, loading, nip05State }
}
