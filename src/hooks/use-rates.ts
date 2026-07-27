"use client"

import { useQuery } from "@tanstack/react-query"

import type { RateSnapshot } from "@/lib/domain/rates"
import { CACHE, qk } from "@/lib/query/keys"

/**
 * The BTC rate, shared by every component that shows a converted price.
 *
 * Backed by the persisted query cache, so a returning visitor gets a price in
 * pesos on the first paint instead of a dash — then the real rate lands a
 * moment later and the number rolls to it.
 */
async function fetchRates(): Promise<RateSnapshot> {
  const res = await fetch("/api/rates", { cache: "no-store" })
  if (!res.ok) throw new Error("rates unavailable")
  const data = (await res.json()) as RateSnapshot
  if (!data?.satPrice?.SAT) throw new Error("malformed rates")
  return data
}

export interface RatesResult {
  rates: RateSnapshot | null
  /** Only true before the FIRST snapshot — a refresh must not blank the UI. */
  loading: boolean
  /** True while a background refresh is in flight over existing data. */
  refreshing: boolean
  refresh: () => void
}

export function useRates(): RatesResult {
  const query = useQuery({
    queryKey: qk.rates(),
    queryFn: fetchRates,
    ...CACHE.rates,
    // A quote on screen for ten minutes is a quote nobody should act on.
    refetchInterval: 60_000,
    // Polling a rate for a phone in someone's pocket is pure battery.
    refetchIntervalInBackground: false,
  })

  return {
    rates: query.data ?? null,
    loading: query.isPending,
    refreshing: query.isFetching && !query.isPending,
    refresh: () => void query.refetch(),
  }
}
