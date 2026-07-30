"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import type { Benefit } from "@/lib/domain/coupon"
import { createNip98Token } from "@/lib/nostr/nip98"
import type { SignedEvent, SignerPort } from "@/lib/nostr/types"
import { CACHE, qk } from "@/lib/query/keys"

/**
 * The coupon API, from the merchant's browser.
 *
 * Unlike everything else in this app, these writes are NOT queued for a relay:
 * they go to our own Postgres and are true the moment the response comes back.
 * So there is no draft/published split and no publish monitor here — a plain
 * fetch plus an invalidation is the honest model, and pretending otherwise would
 * show a "pendiente" badge that never resolves.
 *
 * What that costs is one NIP-98 signature per request, and on a NIP-46 bunker a
 * signature is a round trip to the merchant's phone. Hence: one GET that returns
 * coupons AND minters together, and mutations that invalidate rather than
 * refetching optimistically.
 */

export interface CouponJson {
  id: string
  name: string
  description: string
  image: string | null
  /** null when the stored terms no longer parse — the row is shown as broken. */
  benefit: Benefit | null
  maxUses: number | null
  minted: number
  claimed: number
  expiresAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface MinterJson {
  pubkey: string
  npub: string
  label: string | null
  createdAt: number
}

export interface MintedCoupon {
  coupon: Benefit
  name: string
  description: string
  npub: string
  image: string | null
  nonce: string
  expiresAt: number | null
  voucher: SignedEvent
}

/** One issued coupon, as the detail panel lists it. */
export interface MintJson {
  nonce: string
  status: "minted" | "claimed" | "voided"
  mintedBy: string
  mintedByNpub: string
  mintedAt: number
  claimedAt: number | null
  voidedAt: number | null
}

export interface CouponInput {
  name: string
  description: string
  image: string | null
  benefit: Benefit
  maxUses: number | null
  /** Unix seconds. */
  expiresAt: number | null
}

export type CouponPatch = Partial<CouponInput> & { archived?: boolean }

/** Thrown with the server's own Spanish message, so callers can render it. */
export class CouponApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = "CouponApiError"
  }
}

/**
 * Signed fetch. The URL must be absolute, because that is what gets signed and
 * what the server compares against — a relative path would produce a token
 * bound to nothing.
 */
async function nip98Fetch<T>(
  signer: SignerPort,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = init.method ?? "GET"
  const url = new URL(path, window.location.origin).toString()
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)

  let authorization: string
  try {
    authorization = await createNip98Token(signer, url, method, body)
  } catch (e) {
    // A bunker that refuses kind 27235 lands here. Sessions connected before
    // this kind was added to SIGNING_KINDS have to reconnect once.
    throw new CouponApiError(
      e instanceof Error && /denied|reject/i.test(e.message)
        ? "Tu firmante rechazó la autorización. Si usás un bunker, volvé a conectarlo."
        : "No pudimos firmar la autorización. Probá de nuevo.",
      0
    )
  }

  const res = await fetch(url, {
    method,
    body,
    cache: "no-store",
    headers: {
      authorization,
      ...(body ? { "content-type": "application/json" } : {}),
    },
  })

  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; reason?: string })
    | null

  if (!res.ok) {
    throw new CouponApiError(
      data?.error ?? "Algo salió mal. Probá de nuevo.",
      res.status,
      data?.reason
    )
  }
  return data as T
}

export interface CouponsResult {
  coupons: CouponJson[]
  minters: MinterJson[]
  /** The merchant's stored discovery event. Null until they activate. */
  discovery: SignedEvent | null
  loading: boolean
  refreshing: boolean
  /** The server's message when the last read failed — 503 when unconfigured. */
  error: CouponApiError | null
  refresh: () => void
  create: (input: CouponInput) => Promise<CouponJson>
  update: (id: string, patch: CouponPatch) => Promise<CouponJson>
  remove: (id: string) => Promise<{ deleted: boolean; archived: boolean }>
  mint: (id: string) => Promise<MintedCoupon>
  addMinter: (pubkey: string, label: string) => Promise<MinterJson>
  removeMinter: (pubkey: string) => Promise<void>
  /** Remember a signed announcement so it survives a reload and can be re-sent. */
  saveDiscovery: (event: SignedEvent) => Promise<void>
  /** False until there is a signer to sign tokens with. */
  ready: boolean
}

export function useCoupons(): CouponsResult {
  const { state, signer } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const client = useQueryClient()

  const query = useQuery({
    queryKey: qk.coupons(pubkey ?? "anon"),
    enabled: !!pubkey && !!signer,
    ...CACHE.coupons,
    // One request, one signature: the page needs both lists to render.
    queryFn: () =>
      nip98Fetch<{
        coupons: CouponJson[]
        minters: MinterJson[]
        discovery: SignedEvent | null
      }>(signer!, "/api/coupons"),
    // A 503 (no database) or a refused signature will not fix itself on retry.
    retry: false,
  })

  const invalidate = React.useCallback(() => {
    void client.invalidateQueries({ queryKey: qk.coupons(pubkey ?? "anon") })
  }, [client, pubkey])

  const createMutation = useMutation({
    mutationFn: (input: CouponInput) =>
      nip98Fetch<{ coupon: CouponJson }>(signer!, "/api/coupons", {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CouponPatch }) =>
      nip98Fetch<{ coupon: CouponJson }>(signer!, `/api/coupons/${id}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: invalidate,
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      nip98Fetch<{ deleted: boolean; archived: boolean }>(signer!, `/api/coupons/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  })

  const mintMutation = useMutation({
    mutationFn: (couponId: string) =>
      nip98Fetch<MintedCoupon>(signer!, "/api/coupons/mint", {
        method: "POST",
        body: { couponId },
      }),
    // Minting moves the counters, so the list is stale the moment it succeeds.
    onSuccess: invalidate,
  })

  const addMinterMutation = useMutation({
    mutationFn: ({ pubkey: minter, label }: { pubkey: string; label: string }) =>
      nip98Fetch<{ minter: MinterJson }>(signer!, "/api/coupons/minters", {
        method: "POST",
        body: { pubkey: minter, label },
      }),
    onSuccess: invalidate,
  })

  const saveDiscoveryMutation = useMutation({
    mutationFn: (event: SignedEvent) =>
      nip98Fetch<{ event: SignedEvent }>(signer!, "/api/coupons/discovery", {
        method: "PUT",
        body: { event },
      }),
    onSuccess: invalidate,
  })

  const removeMinterMutation = useMutation({
    mutationFn: (minter: string) =>
      nip98Fetch<{ removed: boolean }>(
        signer!,
        `/api/coupons/minters/${encodeURIComponent(minter)}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  })

  return {
    coupons: query.data?.coupons ?? [],
    minters: query.data?.minters ?? [],
    discovery: query.data?.discovery ?? null,
    loading: query.isPending && !!pubkey && !!signer,
    refreshing: query.isFetching && !query.isPending,
    error: query.error instanceof CouponApiError ? query.error : null,
    refresh: () => void query.refetch(),
    create: async (input) => (await createMutation.mutateAsync(input)).coupon,
    update: async (id, patch) => (await updateMutation.mutateAsync({ id, patch })).coupon,
    remove: (id) => removeMutation.mutateAsync(id),
    mint: (id) => mintMutation.mutateAsync(id),
    addMinter: async (minter, label) =>
      (await addMinterMutation.mutateAsync({ pubkey: minter, label })).minter,
    removeMinter: async (minter) => {
      await removeMinterMutation.mutateAsync(minter)
    },
    saveDiscovery: async (event) => {
      await saveDiscoveryMutation.mutateAsync(event)
    },
    ready: !!pubkey && !!signer,
  }
}

/**
 * The instances of one coupon, loaded only when the merchant opens it.
 *
 * Its own query rather than part of the coupons list: a coupon handed out all
 * month has hundreds of these, and the page that opens on the definitions does
 * not need any of them.
 */
export function useCouponMints(couponId: string | null): {
  mints: MintJson[]
  loading: boolean
  error: CouponApiError | null
  voidMint: (nonce: string) => Promise<void>
} {
  const { state, signer } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const client = useQueryClient()

  const query = useQuery({
    queryKey: qk.couponMints(couponId ?? "none"),
    enabled: !!couponId && !!pubkey && !!signer,
    ...CACHE.coupons,
    retry: false,
    queryFn: () =>
      nip98Fetch<{ mints: MintJson[] }>(signer!, `/api/coupons/${couponId}/mints`),
  })

  const voidMutation = useMutation({
    mutationFn: (nonce: string) =>
      nip98Fetch<{ mint: MintJson }>(
        signer!,
        `/api/coupons/${couponId}/mints/${encodeURIComponent(nonce)}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.couponMints(couponId ?? "none") })
      // Voiding hands the slot back to the cap, so the definition's counters
      // moved too.
      void client.invalidateQueries({ queryKey: qk.coupons(pubkey ?? "anon") })
    },
  })

  return {
    mints: query.data?.mints ?? [],
    loading: query.isPending && !!couponId && !!pubkey && !!signer,
    error: query.error instanceof CouponApiError ? query.error : null,
    voidMint: async (nonce) => {
      await voidMutation.mutateAsync(nonce)
    },
  }
}
