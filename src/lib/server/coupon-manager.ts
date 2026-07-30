import "server-only"

import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import { nip19 } from "nostr-tools"

import type { EventBody } from "@/lib/domain/product"
import { nowSeconds } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"

/**
 * This service's own nostr identity — the "coupon manager".
 *
 * Every other key in this app belongs to a person: the merchant signs with
 * their extension or their bunker, and a shopper's order is signed by a key that
 * exists for one millisecond (see D2 in src/lib/domain/order.ts). This one is
 * different, and deliberately so: a coupon has to be verifiable by a cashier
 * whose terminal has never talked to us before. The merchant publishes this
 * pubkey in their discovery event, we sign every coupon we issue with the
 * matching secret, and the terminal can check a coupon offline.
 *
 * That means the key's identity must be STABLE. Which is why, unlike
 * LN_PROXY_SECRET in signed-url.ts, there is no random fallback: a per-process
 * key would silently invalidate every voucher and every discovery event already
 * published, and the failure would look like "coupons randomly stopped
 * verifying" months later. Missing env var ⇒ the coupon endpoints answer 503.
 */

export interface CouponManager {
  /** Hex. This is what a POS compares a voucher's author against. */
  pubkey: string
  npub: string
  /** Signs a voucher. Never publishes it — vouchers ride in JSON responses. */
  sign(body: EventBody): SignedEvent
}

const cache = globalThis as typeof globalThis & {
  __couponManager?: CouponManager | null
}

let warned = false

export function getCouponManager(): CouponManager | null {
  if (cache.__couponManager !== undefined) return cache.__couponManager

  const raw = process.env.COUPON_MANAGER_NSEC?.trim()
  if (!raw) {
    if (!warned) {
      warned = true
      console.warn(
        "[coupons] COUPON_MANAGER_NSEC is unset; minting and claiming will answer 503."
      )
    }
    cache.__couponManager = null
    return null
  }

  let secret: Uint8Array
  try {
    const decoded = nip19.decode(raw)
    if (decoded.type !== "nsec") throw new Error(`expected an nsec, got ${decoded.type}`)
    secret = decoded.data
  } catch (e) {
    // Loud, because the operator set the variable and it does not work — that is
    // a deployment mistake worth a line in the log every boot.
    console.error(
      `[coupons] COUPON_MANAGER_NSEC is not a valid nsec: ${
        e instanceof Error ? e.message : "unknown error"
      }`
    )
    cache.__couponManager = null
    return null
  }

  const pubkey = getPublicKey(secret)
  const manager: CouponManager = {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    sign: (body) =>
      // Vouchers are ephemeral-kind events, not addressable ones: there is no
      // coordinate to keep a high-water mark for, so nowSeconds() is right and
      // nextCreatedAt() would be meaningless here.
      finalizeEvent({ ...body, created_at: nowSeconds() }, secret) as SignedEvent,
  }

  cache.__couponManager = manager
  return manager
}

/** Test seam: forget the cached key so the next call re-reads the env. */
export function __resetCouponManager(): void {
  cache.__couponManager = undefined
  warned = false
}
