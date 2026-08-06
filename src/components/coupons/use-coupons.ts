"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { ApiError, asApiError } from "@/lib/api/error"
import { apiFetch } from "@/lib/api/fetch"
import type { Benefit } from "@/lib/domain/coupon"
import type { SignedEvent } from "@/lib/nostr/types"
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
 * Requests carry the session bearer (src/lib/api/session.ts), so the merchant
 * signs once per tab rather than once per call — on a NIP-46 bunker a signature
 * is a round trip to their phone. The batching that predates the session is
 * still worth keeping for the round trips alone: one GET returns coupons AND
 * minters, and mutations invalidate rather than refetch optimistically.
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

/**
 * Re-exported under the old name: two exported interfaces here type their
 * `error` field with it, and the class itself is no longer coupon-specific.
 */
export { ApiError as CouponApiError }

export interface CouponsResult {
  coupons: CouponJson[]
  minters: MinterJson[]
  /** The merchant's stored discovery event. Null until they activate. */
  discovery: SignedEvent | null
  loading: boolean
  refreshing: boolean
  /** The server's message when the last read failed — 503 when unconfigured. */
  error: ApiError | null
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
      apiFetch<{
        coupons: CouponJson[]
        minters: MinterJson[]
        discovery: SignedEvent | null
      }>(signer!, pubkey!, "/api/coupons"),
    // A 503 (no database) or a refused signature will not fix itself on retry.
    retry: false,
  })

  const invalidate = React.useCallback(() => {
    void client.invalidateQueries({ queryKey: qk.coupons(pubkey ?? "anon") })
  }, [client, pubkey])

  const createMutation = useMutation({
    mutationFn: (input: CouponInput) =>
      apiFetch<{ coupon: CouponJson }>(signer!, pubkey!, "/api/coupons", {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CouponPatch }) =>
      apiFetch<{ coupon: CouponJson }>(signer!, pubkey!, `/api/coupons/${id}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: invalidate,
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean; archived: boolean }>(signer!, pubkey!, `/api/coupons/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  })

  const mintMutation = useMutation({
    mutationFn: (couponId: string) =>
      apiFetch<MintedCoupon>(signer!, pubkey!, "/api/coupons/mint", {
        method: "POST",
        body: { couponId },
      }),
    // Minting moves the counters, so the list is stale the moment it succeeds.
    onSuccess: invalidate,
  })

  const addMinterMutation = useMutation({
    mutationFn: ({ pubkey: minter, label }: { pubkey: string; label: string }) =>
      apiFetch<{ minter: MinterJson }>(signer!, pubkey!, "/api/coupons/minters", {
        method: "POST",
        body: { pubkey: minter, label },
      }),
    onSuccess: invalidate,
  })

  const saveDiscoveryMutation = useMutation({
    mutationFn: (event: SignedEvent) =>
      apiFetch<{ event: SignedEvent }>(signer!, pubkey!, "/api/coupons/discovery", {
        method: "PUT",
        body: { event },
      }),
    onSuccess: invalidate,
  })

  const removeMinterMutation = useMutation({
    mutationFn: (minter: string) =>
      apiFetch<{ removed: boolean }>(
        signer!,
        pubkey!,
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
    error: asApiError(query.error),
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
  error: ApiError | null
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
      apiFetch<{ mints: MintJson[] }>(signer!, pubkey!, `/api/coupons/${couponId}/mints`),
  })

  const voidMutation = useMutation({
    mutationFn: (nonce: string) =>
      apiFetch<{ mint: MintJson }>(
        signer!,
        pubkey!,
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
    error: asApiError(query.error),
    voidMint: async (nonce) => {
      await voidMutation.mutateAsync(nonce)
    },
  }
}

/** One redemption, with the order it paid for. */
export interface RedemptionJson {
  nonce: string
  claimedAt: number
  couponId: string
  name: string
  benefit: Benefit | null
  /** The signed kind-9734. Null when the coupon was redeemed outside a checkout. */
  order: SignedEvent | null
  orderId: string | null
  /** `0` means it was reclaimed rather than paid — no receipt will ever exist. */
  amountMsat: number | null
}

/**
 * Every coupon this merchant has had redeemed.
 *
 * Read by two screens: the "Canjeados" tab, and the order list — which needs it
 * because a reclaimed order has no zap receipt and would otherwise be invisible
 * there.
 */
export function useRedemptions(enabled = true): {
  redemptions: RedemptionJson[]
  loading: boolean
  error: ApiError | null
} {
  const { state, signer } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null

  const query = useQuery({
    queryKey: qk.couponRedemptions(pubkey ?? "anon"),
    enabled: enabled && !!pubkey && !!signer,
    ...CACHE.coupons,
    retry: false,
    queryFn: () =>
      apiFetch<{ redemptions: RedemptionJson[] }>(
        signer!,
        pubkey!,
        "/api/coupons/redemptions"
      ),
  })

  return {
    redemptions: query.data?.redemptions ?? [],
    loading: query.isPending && enabled && !!pubkey && !!signer,
    error: asApiError(query.error),
  }
}
