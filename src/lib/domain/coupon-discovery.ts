import { KINDS } from "@/lib/domain/kinds"
import type { EventBody } from "@/lib/domain/product"
import { nextCreatedAt } from "@/lib/nostr/created-at"
import { coordinate, tagValue } from "@/lib/nostr/tags"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * The merchant's coupon endpoints, published as NIP-78 app data.
 *
 * This event is how a POS that has never heard of us finds out where to mint and
 * claim: it reads the merchant's npub, finds this `d`, and gets two URLs plus
 * the pubkey whose signature it should expect on the vouchers those URLs
 * return. Kind 30078 is addressable, so moving to a new host is an edit to one
 * event rather than a migration nobody can coordinate.
 *
 * THE CONTENT IS PLAINTEXT. Every other 30078 in this app is NIP-44 sealed to
 * the merchant themselves (see woo-config.ts), because it holds credentials.
 * This one is the opposite: it is an announcement, and a POS run by somebody
 * else has to be able to read it. There is nothing secret in it — the mint
 * endpoint is protected by NIP-98 and an authorized-npub list, not by the URL
 * being hard to find.
 */

/** Our `d` tag. Kind 30078 is shared by every app; the `d` is the whole fence. */
export const COUPON_DISCOVERY_D = "lacrypta.merchant/coupons"

export interface CouponDiscovery {
  v: 1
  /** Hex pubkey of the service that signs vouchers. Verify them against this. */
  managerPubkey: string
  /** Absolute URL. POST, NIP-98, authorized npubs only. */
  mintUrl: string
  /** Absolute URL. GET to check a nonce, POST to redeem it. */
  claimUrl: string
}

export type ParsedDiscovery =
  | { ok: true; value: CouponDiscovery }
  | { ok: false; reason: string }

const MAX_URL = 500
const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Endpoint URLs must be https, with the usual localhost exception so the whole
 * flow can be exercised against `npm run dev` without a tunnel.
 */
function normalizeEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (!value || value.length > MAX_URL) return null
  try {
    const url = new URL(value)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Parse the announcement.
 *
 * Any version other than 1 is DISCARDED, never migrated — same rule as the cart
 * and the Woo config. A half-understood announcement means pointing a cashier's
 * terminal at a URL we guessed the meaning of.
 */
export function parseCouponDiscovery(content: string): ParsedDiscovery {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return { ok: false, reason: "no es JSON" }
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "no es un objeto" }

  const c = raw as Partial<CouponDiscovery>
  if (c.v !== 1) return { ok: false, reason: `versión desconocida: ${String(c.v)}` }

  if (typeof c.managerPubkey !== "string" || !HEX64.test(c.managerPubkey)) {
    return { ok: false, reason: "managerPubkey inválido" }
  }
  const mintUrl = normalizeEndpoint(c.mintUrl)
  if (!mintUrl) return { ok: false, reason: "mintUrl inválido" }
  const claimUrl = normalizeEndpoint(c.claimUrl)
  if (!claimUrl) return { ok: false, reason: "claimUrl inválido" }

  return {
    ok: true,
    value: {
      v: 1,
      managerPubkey: c.managerPubkey.toLowerCase(),
      mintUrl,
      claimUrl,
    },
  }
}

export function serializeCouponDiscovery(c: CouponDiscovery): string {
  return JSON.stringify(c)
}

/** The two endpoints, derived from wherever this deployment is reachable. */
export function couponEndpoints(origin: string): { mintUrl: string; claimUrl: string } {
  const base = origin.replace(/\/+$/, "")
  return {
    mintUrl: `${base}/api/coupons/mint`,
    claimUrl: `${base}/api/coupons/claim`,
  }
}

/**
 * Is this 30078 one of ours, and safe to replace?
 *
 * Same rule as `isOurWooConfig`: only ever publish over a `d` we generated,
 * from the author we expect.
 */
export function isOurCouponDiscovery(e: SignedEvent, pubkey: string): boolean {
  return (
    e.kind === KINDS.APP_DATA &&
    e.pubkey === pubkey &&
    tagValue(e, "d") === COUPON_DISCOVERY_D
  )
}

/** The timestamp-free half. Same split as `productEventBody`. */
export function couponDiscoveryEventBody(c: CouponDiscovery): EventBody {
  return {
    kind: KINDS.APP_DATA,
    content: serializeCouponDiscovery(c),
    tags: [
      ["d", COUPON_DISCOVERY_D],
      ["client", "merchant-manager"],
    ],
  }
}

export function buildCouponDiscoveryEvent(
  c: CouponDiscovery,
  pubkey: string,
  previousCreatedAt?: number
): EventTemplate {
  return {
    ...couponDiscoveryEventBody(c),
    created_at: nextCreatedAt(
      coordinate(KINDS.APP_DATA, pubkey, COUPON_DISCOVERY_D),
      previousCreatedAt
    ),
  }
}
