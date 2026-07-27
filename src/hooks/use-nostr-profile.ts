"use client"

import { useQuery } from "@tanstack/react-query"

import { KINDS } from "@/lib/domain/kinds"
import { parseProfileEvent, type NostrProfile } from "@/lib/domain/profile"
import { queryEvents } from "@/lib/nostr/backend"
import { LOOKUP_RELAYS, dedupeRelays, DEFAULT_RELAYS } from "@/lib/nostr/relays"
import { CACHE, qk } from "@/lib/query/keys"

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

async function fetchProfile(pubkey: string): Promise<NostrProfile | null> {
  // purplepag.es first: it is the de-facto kind-0 indexer and answers far
  // more reliably than general-purpose relays for metadata.
  const relays = dedupeRelays([...LOOKUP_RELAYS, ...DEFAULT_RELAYS])
  const events = await queryEvents(
    [{ kinds: [KINDS.METADATA], authors: [pubkey] }],
    relays,
    { timeoutMs: 8_000, label: "Perfil (kind 0)" }
  )
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
  return newest ? parseProfileEvent(newest) : null
}

async function fetchNip05(address: string, pubkey: string): Promise<Nip05State> {
  try {
    const res = await fetch(`/api/nip05?address=${encodeURIComponent(address)}`, {
      cache: "no-store",
    })
    const data = (await res.json()) as { pubkey?: string | null }
    if (!res.ok) return "unreachable"
    // A claim only counts once the DOMAIN maps it back to this exact pubkey.
    // Anything else is shown without a check mark.
    return data.pubkey?.toLowerCase() === pubkey.toLowerCase()
      ? "verified"
      : "mismatch"
  } catch {
    return "unreachable"
  }
}

/**
 * A merchant's display name, avatar and verified handle.
 *
 * Persisted, so the forty avatars on a busy screen paint from disk on reload
 * and cost zero relay round trips until they go stale. That is the single
 * most visible part of local-first here: names and faces used to blink in
 * seconds after everything else had already rendered.
 */
export function useNostrProfile(pubkey: string | null): ProfileResult {
  const profileQuery = useQuery({
    queryKey: qk.profile(pubkey ?? ""),
    queryFn: () => fetchProfile(pubkey!),
    enabled: !!pubkey,
    ...CACHE.profile,
    // A missing kind-0 is very often "no answer yet" rather than "no
    // profile", so a null result must not be cached as long as a real one.
    staleTime: (q) => (q.state.data ? CACHE.profile.staleTime : 0),
  })

  const profile = profileQuery.data ?? null
  const claimed = profile?.nip05

  const nip05Query = useQuery({
    queryKey: qk.nip05(claimed ?? "", pubkey ?? ""),
    queryFn: () => fetchNip05(claimed!, pubkey!),
    enabled: !!claimed && !!pubkey,
    ...CACHE.nip05,
  })

  const nip05State: Nip05State = !claimed
    ? "none"
    : (nip05Query.data ?? "checking")

  return {
    profile,
    loading: profileQuery.isPending && !!pubkey,
    nip05State,
  }
}
