import { beforeEach, describe, expect, it } from "vitest"

import { __resetCreatedAtState, nowSeconds } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"
import {
  COUPON_DISCOVERY_D,
  buildCouponDiscoveryEvent,
  couponDiscoveryEventBody,
  couponEndpoints,
  isOurCouponDiscovery,
  parseCouponDiscovery,
  type CouponDiscovery,
} from "./coupon-discovery"

const PUBKEY = "a".repeat(64)
const OTHER = "b".repeat(64)
const MANAGER = "c".repeat(64)

const discovery = (over: Partial<CouponDiscovery> = {}): CouponDiscovery => ({
  v: 2,
  managerPubkey: MANAGER,
  mintUrl: "https://shop.example/api/coupons/mint",
  claimUrl: "https://shop.example/api/coupons/claim",
  ...over,
})

/** The wire form, built by the same function the app signs. */
const body = (over: Partial<CouponDiscovery> = {}) =>
  couponDiscoveryEventBody(discovery(over))

const event = (over: Partial<SignedEvent> = {}): SignedEvent => ({
  id: "e".repeat(64),
  pubkey: PUBKEY,
  created_at: 1_700_000_000,
  ...body(),
  sig: "s".repeat(128),
  ...over,
})

beforeEach(__resetCreatedAtState)

describe("parseCouponDiscovery", () => {
  it("round-trips through the tag and the content", () => {
    const parsed = parseCouponDiscovery(body())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(discovery())
  })

  it("lowercases the manager pubkey so it compares to a voucher author", () => {
    const parsed = parseCouponDiscovery(body({ managerPubkey: MANAGER.toUpperCase() }))
    expect(parsed.ok && parsed.value.managerPubkey).toBe(MANAGER)
  })

  it("names the old format instead of blaming the missing tag", () => {
    // The v1 announcement, verbatim: the pubkey inside the content and no `p`.
    // Every merchant activated before this refactor has one of these stored,
    // and the message is what sends them to the "Reactivar" button.
    const parsed = parseCouponDiscovery({
      tags: [["d", COUPON_DISCOVERY_D]],
      content: JSON.stringify({ ...discovery(), v: 1 }),
    })
    expect(parsed).toEqual({ ok: false, reason: "formato viejo, v1" })
  })

  it("discards an unknown version instead of migrating it", () => {
    const parsed = parseCouponDiscovery({
      ...body(),
      content: JSON.stringify({ ...discovery(), v: 3 }),
    })
    expect(parsed).toEqual({ ok: false, reason: "versión desconocida: 3" })
  })

  it("requires a 64-hex manager pubkey in the p tag", () => {
    const withTags = (tags: string[][]) => parseCouponDiscovery({ ...body(), tags })
    expect(withTags([["d", COUPON_DISCOVERY_D]]).ok).toBe(false)
    expect(withTags([["p", "abc"]]).ok).toBe(false)
    expect(withTags([["p", `npub1${"x".repeat(58)}`]]).ok).toBe(false)
    expect(withTags([]).ok).toBe(false)
  })

  it("insists on https, except on localhost for dev", () => {
    expect(parseCouponDiscovery(body({ mintUrl: "http://shop.example/api/coupons/mint" })).ok).toBe(
      false
    )
    expect(
      parseCouponDiscovery(
        body({
          mintUrl: "http://localhost:4321/api/coupons/mint",
          claimUrl: "http://127.0.0.1:4321/api/coupons/claim",
        })
      ).ok
    ).toBe(true)
  })

  it("rejects credentials in the URL and absurdly long ones", () => {
    expect(
      parseCouponDiscovery(body({ mintUrl: "https://u:p@shop.example/api/coupons/mint" })).ok
    ).toBe(false)
    expect(
      parseCouponDiscovery(body({ claimUrl: `https://shop.example/${"x".repeat(600)}` })).ok
    ).toBe(false)
  })

  it("rejects garbage", () => {
    expect(parseCouponDiscovery({ ...body(), content: "not json" }).ok).toBe(false)
    expect(parseCouponDiscovery({ ...body(), content: "[]" }).ok).toBe(false)
    expect(parseCouponDiscovery({ ...body(), content: JSON.stringify({ v: 2 }) }).ok).toBe(false)
  })
})

describe("couponEndpoints", () => {
  it("derives both URLs from an origin, trailing slash or not", () => {
    expect(couponEndpoints("https://shop.example")).toEqual({
      mintUrl: "https://shop.example/api/coupons/mint",
      claimUrl: "https://shop.example/api/coupons/claim",
    })
    expect(couponEndpoints("https://shop.example/").mintUrl).toBe(
      "https://shop.example/api/coupons/mint"
    )
  })
})

describe("isOurCouponDiscovery", () => {
  it("accepts only our own d, from the expected author, at kind 30078", () => {
    expect(isOurCouponDiscovery(event(), PUBKEY)).toBe(true)
    expect(isOurCouponDiscovery(event({ pubkey: OTHER }), PUBKEY)).toBe(false)
    expect(isOurCouponDiscovery(event({ kind: 30402 }), PUBKEY)).toBe(false)
    expect(
      isOurCouponDiscovery(event({ tags: [["d", "lacrypta.merchant/woocommerce"]] }), PUBKEY)
    ).toBe(false)
    expect(isOurCouponDiscovery(event({ tags: [] }), PUBKEY)).toBe(false)
  })
})

describe("event building", () => {
  it("puts the manager key in an indexable p tag, out of the content", () => {
    const built = body()
    expect(built.kind).toBe(30078)
    expect(built.tags).toEqual([
      ["d", COUPON_DISCOVERY_D],
      ["p", MANAGER],
      ["client", "merchant-manager"],
    ])
    // The point of the refactor: a relay can index a tag, never a field inside
    // a content string. If this key ever comes back, the index is a lie.
    expect(JSON.parse(built.content)).not.toHaveProperty("managerPubkey")
    // Plaintext on purpose: a POS run by somebody else has to read this.
    expect(JSON.parse(built.content)).toEqual({
      v: 2,
      mintUrl: discovery().mintUrl,
      claimUrl: discovery().claimUrl,
    })
  })

  it("leaves created_at to the builder", () => {
    expect(couponDiscoveryEventBody(discovery())).not.toHaveProperty("created_at")
  })

  it("advances created_at past the event it replaces", () => {
    // Must be a plausible "now": nextCreatedAt refuses to date an event more
    // than a minute into the future, because relays reject those outright.
    const previous = nowSeconds()
    const built = buildCouponDiscoveryEvent(discovery(), PUBKEY, previous)
    expect(built.created_at).toBe(previous + 1)
    // And again, from the in-memory high-water mark rather than the argument.
    expect(buildCouponDiscoveryEvent(discovery(), PUBKEY).created_at).toBe(previous + 2)
  })
})
