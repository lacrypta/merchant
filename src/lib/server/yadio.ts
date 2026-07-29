import "server-only"

import { request } from "undici"

import { satPriceFromUnitsPerBtc, type RateSnapshot } from "@/lib/domain/rates"
import { readJsonBody, ssrfSafeAgent } from "@/lib/server/ssrf"

/**
 * The BTC price oracle.
 *
 * Yadio is the one that matters here: it is the only free API that tracks the
 * Argentine blue rate, and an official ARS rate would misprice a bar tab in
 * Buenos Aires by a factor that customers would notice immediately.
 *
 * Shape (verified live): `{"BTC":{"ARS":103657091.58,"USD":65017.49,…},
 * "base":"BTC","timestamp":1785114923779}` — units per BTC, ~100 currencies,
 * timestamp in milliseconds.
 */

const YADIO_URL = "https://api.yadio.io/exrates/BTC"

/** How long a last-good snapshot may be served after the oracle starts failing. */
const STALE_GRACE_MS = 60 * 60_000

/** How long a fresh snapshot is reused before we go back to the oracle. */
const FRESH_MS = 60_000

let memo: RateSnapshot | undefined
/**
 * Collapses concurrent callers onto one upstream request. Two hundred people
 * hitting checkout in the same second is one Yadio call, not two hundred.
 */
let inflight: Promise<RateSnapshot | null> | undefined

export class RatesUnavailableError extends Error {
  constructor() {
    super("No rate snapshot available")
    this.name = "RatesUnavailableError"
  }
}

/**
 * @throws RatesUnavailableError only when the oracle fails AND there is no
 *   usable memo — i.e. the very first request after a cold start, offline.
 *   Every other failure degrades to `stale: true`, because a rate from ten
 *   minutes ago is far more useful than a 502.
 */
export async function getRates(): Promise<RateSnapshot> {
  const now = Date.now()

  if (memo && !memo.stale && now - memo.asOf < FRESH_MS) return memo

  inflight ??= fetchSnapshot().finally(() => {
    inflight = undefined
  })
  const fresh = await inflight

  if (fresh) {
    memo = fresh
    return fresh
  }

  if (memo && now - memo.asOf < STALE_GRACE_MS) {
    // Re-flag rather than mutate: callers may be holding the old object.
    memo = { ...memo, stale: true }
    return memo
  }

  throw new RatesUnavailableError()
}

/** Resolves to null on any failure — the caller decides what a failure means. */
async function fetchSnapshot(): Promise<RateSnapshot | null> {
  try {
    const res = await request(YADIO_URL, {
      method: "GET",
      // A fixed hostname doesn't need SSRF protection, but routing every
      // outbound call through one dispatcher means one timeout policy and one
      // place to change it.
      dispatcher: ssrfSafeAgent(),
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
      headers: { accept: "application/json" },
    })

    if (res.statusCode !== 200) {
      res.body.destroy()
      return null
    }

    const json = await readJsonBody(res.body)
    if (!json) return null

    const body = json as { BTC?: Record<string, unknown>; timestamp?: unknown }
    if (typeof body.BTC !== "object" || body.BTC === null) return null

    const satPrice = satPriceFromUnitsPerBtc(body.BTC)
    // SAT is free; anything less than SAT plus one real currency means the
    // payload changed shape and we should not pretend to have rates.
    if (Object.keys(satPrice).length < 2) return null

    const ts = Number(body.timestamp)
    // Trust the oracle's clock only when it is plausible. A timestamp from
    // 1970 or from next year would poison every freshness check downstream.
    const asOf =
      Number.isFinite(ts) && Math.abs(Date.now() - ts) < 24 * 60 * 60_000
        ? ts
        : Date.now()

    return { base: "SAT", satPrice, asOf, stale: false, source: "yadio" }
  } catch {
    return null
  }
}
