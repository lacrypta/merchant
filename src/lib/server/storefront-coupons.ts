import "server-only"

import { cache } from "react"

import {
  COUPON_DISCOVERY_D,
  parseCouponDiscovery,
  type CouponDiscovery,
} from "@/lib/domain/coupon-discovery"
import { KINDS } from "@/lib/domain/kinds"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
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
 */
export const getStorefrontCoupons = cache(
  async (
    pubkey: string,
    relayHints: readonly string[] = []
  ): Promise<CouponDiscovery | null> => {
    const relays = dedupeRelays([...relayHints, ...DEFAULT_RELAYS])

    const { events } = await queryRelays(
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
    )

    // Addressable: the newest wins, exactly as a relay would decide.
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return null

    const parsed = parseCouponDiscovery(newest.content)
    if (!parsed.ok) return null

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
