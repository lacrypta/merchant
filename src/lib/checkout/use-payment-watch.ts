"use client"

import * as React from "react"

import { KINDS } from "@/lib/domain/kinds"
import { matchReceipt, type Order, type Proof } from "@/lib/domain/order"
import { queryEvents, subscribeEvents } from "@/lib/nostr/backend"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"

/**
 * Watch for payment, two ways at once.
 *
 * Neither detector is sufficient on its own in the real world: primal.net —
 * to pick the wallet this was first tested against — advertises
 * `allowsNostr: true` but returns NO LUD-21 `verify` URL, so polling alone
 * would silently degrade that merchant to a manual "ya pagué" button. Other
 * wallets are the exact opposite.
 *
 * Both funnel into the caller's single `settle` reducer, so there is no race
 * to resolve here — whichever fires first transitions the order and the other
 * is merged in as a second proof.
 */

/** 2s for the first minute, 5s to five, then 15s. Plus ±20% jitter. */
function pollDelay(elapsedMs: number): number {
  const base = elapsedMs < 90_000 ? 2_000 : elapsedMs < 300_000 ? 5_000 : 15_000
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

export function usePaymentWatch(
  order: Order | null,
  onProof: (proof: Proof) => void
): { lud21Live: boolean; receiptLive: boolean } {
  /**
   * Which verify-token set we gave up on, after three 4xx in a row.
   *
   * The only piece of watcher status that is genuinely STATE — everything
   * else below is derived during render, because a setState in an effect body
   * cascades a render and the lint rule that forbids it is right.
   */
  const [abandonedTokens, setAbandonedTokens] = React.useState<string | null>(null)

  // Kept in a ref so the effects below don't restart on every render — they
  // own timers and a relay subscription, and tearing those down mid-poll
  // would reset the backoff schedule.
  const onProofRef = React.useRef(onProof)
  React.useEffect(() => {
    onProofRef.current = onProof
  }, [onProof])

  /**
   * The CURRENT order, for the receipt matcher.
   *
   * This must be a ref and not a closure capture. The subscription effect
   * starts the moment an order id exists — which is before the first invoice
   * has been fetched, so `order.invoices` is still empty at that point. Adding
   * the invoice does not change any of the effect's dependencies, so the
   * effect never re-runs, and a captured `order` would stay frozen at
   * `invoices: []` forever. matchReceipt() would then reject every genuine
   * receipt with "payment hash is not one of ours" — a real payment, silently
   * undetected. Observed against a live primal.net receipt.
   */
  const orderRef = React.useRef(order)
  React.useEffect(() => {
    orderRef.current = order
  }, [order])

  const settled = order?.status === "paid" || order?.status === "cancelled"
  const verifyTokens = order?.invoices
    .filter((i) => i.verifyToken && i.state !== "settled")
    .map((i) => `${i.verifyToken}|${i.paymentHash}`)
    .join(",")

  const lud21Live =
    !!verifyTokens && !settled && abandonedTokens !== verifyTokens
  const receiptLive = Boolean(
    order?.id && order.payee.nostrPubkey && order.payee.merchantPubkey && !settled
  )

  // ── LUD-21 polling ────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!verifyTokens || settled) return

    const startedAt = Date.now()
    const pairs = verifyTokens.split(",").map((s) => {
      const [token, hash] = s.split("|")
      return { token: token!, hash: hash! }
    })
    let stopped = false
    let timer: number | undefined
    let consecutive4xx = 0

    const tick = async () => {
      if (stopped) return
      for (const { token, hash } of pairs) {
        try {
          const res = await fetch(`/api/ln/verify?token=${encodeURIComponent(token)}`, {
            cache: "no-store",
          })
          if (res.status >= 400 && res.status < 500) {
            if (++consecutive4xx >= 3) {
              // The endpoint is gone. Stop rather than hammering it; the
              // receipt watcher and the manual button carry from here.
              stopped = true
              setAbandonedTokens(verifyTokens)
              return
            }
            continue
          }
          consecutive4xx = 0
          if (!res.ok) continue

          const data = (await res.json()) as {
            settled?: boolean
            preimage?: string | null
          }
          if (data.settled && !stopped) {
            stopped = true
            onProofRef.current({
              kind: "lud21",
              at: Date.now(),
              paymentHash: hash,
              preimage: data.preimage ?? undefined,
              source: "lud21",
            })
            return
          }
        } catch {
          /* offline; the schedule will retry */
        }
      }
      if (!stopped) {
        timer = window.setTimeout(tick, pollDelay(Date.now() - startedAt))
      }
    }

    // A customer leaves for their wallet app and comes back — that RETURN is
    // the moment payment completed. Waiting up to 15s there is the whole
    // difference between "instant" and "broken".
    const wake = () => {
      if (!stopped && document.visibilityState === "visible") void tick()
    }
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("focus", wake)
    window.addEventListener("online", wake)

    void tick()

    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("focus", wake)
      window.removeEventListener("online", wake)
    }
  }, [verifyTokens, settled])

  // ── NIP-57 zap receipts ───────────────────────────────────────────────
  const orderId = order?.id
  const nostrPubkey = order?.payee.nostrPubkey
  const merchantPubkey = order?.payee.merchantPubkey
  const since = order?.createdAt
  const hintedRelays = order?.zapRequest.tags
    .find((t) => t[0] === "relays")
    ?.slice(1)
    .join(",")

  React.useEffect(() => {
    if (!orderId || !nostrPubkey || !merchantPubkey || !since || settled) return

    // Subscribe to a strictly WIDER set than we advertised: the `relays` tag
    // is a request, not a guarantee, and providers routinely publish to their
    // own defaults instead.
    const relays = dedupeRelays([
      ...(hintedRelays ? hintedRelays.split(",") : []),
      ...DEFAULT_RELAYS,
    ]).filter((r) => !r.includes("purplepag.es"))

    const filters = [
      {
        kinds: [KINDS.ZAP_RECEIPT],
        authors: [nostrPubkey],
        "#p": [merchantPubkey],
        since: since - 120,
      },
    ]

    let stopped = false
    const consider = (e: Parameters<typeof matchReceipt>[0]) => {
      // Read through the ref, NEVER the closure — see orderRef above.
      const current = orderRef.current
      if (stopped || !current) return
      const m = matchReceipt(e, current)
      if (!m.ok) return
      stopped = true
      onProofRef.current({
        kind: m.preimageVerified ? "preimage-verified" : "receipt",
        at: Date.now(),
        paymentHash: m.paymentHash,
        preimage: m.preimage,
        receiptEventId: e.id,
        source: "nostr",
      })
    }

    const unsubscribe = subscribeEvents(filters, relays, consider)

    // Backfill, for a receipt published while this tab was closed.
    void queryEvents(filters, relays, { timeoutMs: 6_000, label: "Recibo de pago (kind 9735)" })
      .then((events) => events.forEach(consider))
      .catch(() => {})

    return () => {
      stopped = true
      unsubscribe()
    }
    // The deps are deliberately the SUBSCRIPTION's identity — which relays,
    // which keys, which window — and not the order itself. The order changes
    // on every proof, and re-subscribing each time would drop events in the
    // gap. Its current value reaches the matcher through orderRef.
  }, [orderId, nostrPubkey, merchantPubkey, since, hintedRelays, settled])

  return { lud21Live, receiptLive }
}
