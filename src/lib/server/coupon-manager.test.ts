import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { nip19 } from "nostr-tools"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { voucherEventBody, type Benefit } from "@/lib/domain/coupon"
import { verifySignedEvent } from "@/lib/nostr/verify"
import { __resetCouponManager, getCouponManager } from "./coupon-manager"

const ORIGINAL = process.env.COUPON_MANAGER_NSEC

beforeEach(__resetCouponManager)

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.COUPON_MANAGER_NSEC
  else process.env.COUPON_MANAGER_NSEC = ORIGINAL
  __resetCouponManager()
})

describe("getCouponManager", () => {
  it("derives the pubkey and npub from the configured nsec", () => {
    const secret = generateSecretKey()
    process.env.COUPON_MANAGER_NSEC = nip19.nsecEncode(secret)

    const manager = getCouponManager()
    expect(manager).not.toBeNull()
    expect(manager!.pubkey).toBe(getPublicKey(secret))
    expect(manager!.npub).toBe(nip19.npubEncode(getPublicKey(secret)))
  })

  it("signs a voucher that verifies against its own pubkey", () => {
    process.env.COUPON_MANAGER_NSEC = nip19.nsecEncode(generateSecretKey())
    const manager = getCouponManager()!

    const voucher = manager.sign(
      voucherEventBody({
        nonce: "hcLPDzERvvHzS4Vn0OLbAQ",
        owner: "a".repeat(64),
        couponId: "33333333-3333-4333-8333-333333333333",
        name: "Promo",
        description: "10% en todo",
        benefit: { type: "percent", percent: 10 } as Benefit,
        phase: "minted",
      })
    )

    // Exactly what a POS does: check the signature, then the author.
    expect(verifySignedEvent(voucher)).toBe(true)
    expect(voucher.pubkey).toBe(manager.pubkey)
    expect(voucher.kind).toBe(20402)
    expect(voucher.created_at).toBeGreaterThan(0)
  })

  it("returns null when unset, so the routes can answer 503", () => {
    delete process.env.COUPON_MANAGER_NSEC
    expect(getCouponManager()).toBeNull()
  })

  it("returns null for anything that is not an nsec", () => {
    for (const value of [
      "hunter2",
      nip19.npubEncode(getPublicKey(generateSecretKey())),
      "nsec1invalid",
      "   ",
    ]) {
      __resetCouponManager()
      process.env.COUPON_MANAGER_NSEC = value
      expect(getCouponManager()).toBeNull()
    }
  })

  it("caches the key rather than decoding per request", () => {
    process.env.COUPON_MANAGER_NSEC = nip19.nsecEncode(generateSecretKey())
    const first = getCouponManager()
    // A second read with the env swapped underneath must return the cached key:
    // rotating mid-process would invalidate vouchers already handed out.
    process.env.COUPON_MANAGER_NSEC = nip19.nsecEncode(generateSecretKey())
    expect(getCouponManager()).toBe(first)
  })
})
