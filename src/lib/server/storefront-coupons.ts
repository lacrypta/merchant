import "server-only"

import { cache } from "react"

import {
  COUPON_DISCOVERY_D,
  parseCouponDiscovery,
  type CouponDiscovery,
} from "@/lib/domain/coupon-discovery"
import { KINDS } from "@/lib/domain/kinds"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { getCouponManager } from "@/lib/server/coupon-manager"
import { queryRelays } from "@/lib/server/relay-read"

/**
 * Does this storefront take coupons, and are they ours to redeem?
 *
 * Two questions in one, and the second is the one that is easy to get wrong.
 * The merchant's announcement says WHERE their coupons live. If it names another
 * deployment, their coupons are in that server's database and ours would answer
 * "cupón inexistente" for every code the customer types — so the field must not
 * appear at all. Showing an input that can only fail is worse than showing
 * nothing.
 *
 * Its own relay query, not part of the catalog fan-out: it is one addressable
 * event by `d`, it answers in a few hundred milliseconds, and the checkout can
 * render the rest of itself while it lands.
 *
 * The manager key is an indexable `p` tag now, and the query still does NOT
 * filter by it. Asking a relay for "the announcement that names me" can hand
 * back an older version while the merchant's current one names another service
 * — and we would show a coupon box for coupons we no longer issue. Newest
 * first, then check who it names.
 */
export const getStorefrontCoupons = cache(
  async (
    pubkey: string,
    relayHints: readonly string[] = []
  ): Promise<CouponDiscovery | null> => {
    const relays = dedupeRelays([...relayHints, ...DEFAULT_RELAYS])

    /**
     * A failed read means "no coupons", never a thrown render.
     *
     * Suspense catches suspension, not rejection: a DNS failure or a dead
     * socket here would propagate to the nearest error boundary and cost the
     * shopper the whole payment screen — over an optional coupon box. Every
     * other failure mode in this function already degrades to null.
     */
    let events
    try {
      ;({ events } = await queryRelays(
        relays,
        [
          {
            kinds: [KINDS.APP_DATA],
            authors: [pubkey],
            "#d": [COUPON_DISCOVERY_D],
            limit: 1,
          },
        ],
        { label: "Anuncio de cupones", timeoutMs: 4_000 }
      ))
    } catch {
      return null
    }

    // Addressable: the newest wins, exactly as a relay would decide.
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return null

    const parsed = parseCouponDiscovery(newest)
    if (!parsed.ok) return null

    /**
     * Two questions, and both have to answer "us".
     *
     * The `p` tag says whose signature the vouchers carry; `servedFromHere`
     * says whose database holds the nonce. Two deployments sharing a
     * COUPON_MANAGER_NSEC name the same key and only one can redeem, so the
     * origin check stays.
     *
     * Without a manager key we could not sign a voucher anyway — the coupon
     * endpoints answer 503 — so the box has no business being on screen.
     */
    const manager = getCouponManager()
    if (!manager || parsed.value.managerPubkey !== manager.pubkey) return null

    return servedFromHere(parsed.value) ? parsed.value : null
  }
)

/**
 * Is the claim endpoint in the announcement this very deployment?
 *
 * Compared by origin rather than by the whole URL: a merchant announcing
 * `https://tienda.ar/api/coupons/claim` and a visitor arriving at the same host
 * are the same service even if a path prefix ever changes.
 */
function servedFromHere(discovery: CouponDiscovery): boolean {
  const base = process.env.NEXT_PUBLIC_APP_URL
  // Without a configured origin we cannot prove the announcement is ours, and
  // guessing would put a coupon box on a storefront whose codes we do not hold.
  if (!base) return false
  try {
    return new URL(discovery.claimUrl).origin === new URL(base).origin
  } catch {
    return false
  }
}
