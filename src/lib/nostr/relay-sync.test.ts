import { describe, expect, it } from "vitest"

import { KINDS } from "@/lib/domain/kinds"
import { COUPON_DISCOVERY_D } from "@/lib/domain/coupon-discovery"
import type { SignedEvent } from "@/lib/nostr/types"
import {
  BASE_PACE_MS,
  MAX_PACE_MS,
  RATE_LIMIT_PACE_MS,
  collectCanonicalEvents,
  isRelayRateLimit,
  nextPaceMs,
  planReplay,
  replayLabel,
  upsertCanonical,
} from "./relay-sync"

const PK = "aa".repeat(32)
const A = "wss://relay.damus.io"
const B = "wss://nos.lol"

function ev(partial: Partial<SignedEvent> & { id: string; kind: number }): SignedEvent {
  return {
    pubkey: PK,
    created_at: 1_800_000_000,
    content: "",
    tags: [],
    sig: "s".repeat(128),
    ...partial,
  }
}

describe("planReplay", () => {
  const product = ev({
    id: "p1",
    kind: KINDS.PRODUCT,
    tags: [
      ["d", "prod"],
      ["title", "Fernet"],
    ],
  })

  it("returns nothing when every relay already has every event", () => {
    const holdings = new Map<string, SignedEvent[]>([
      [A, [product]],
      [B, [product]],
    ])
    expect(planReplay([product], holdings)).toEqual([])
  })

  it("targets only the relay that is missing the event", () => {
    const holdings = new Map<string, SignedEvent[]>([
      [A, [product]],
      [B, []],
    ])
    expect(planReplay([product], holdings)).toEqual([
      { event: product, relays: [B] },
    ])
  })

  it("treats an unreachable relay (empty holdings) as missing everything", () => {
    const holdings = new Map<string, SignedEvent[]>([
      [A, []],
      [B, []],
    ])
    expect(planReplay([product], holdings)).toEqual([
      { event: product, relays: [A, B] },
    ])
  })

  it("skips events that nobody is missing", () => {
    const other = ev({ id: "p2", kind: KINDS.PRODUCT, tags: [["d", "other"]] })
    const holdings = new Map<string, SignedEvent[]>([
      [A, [product]],
      [B, [product]],
    ])
    expect(planReplay([product, other], holdings)).toEqual([
      { event: other, relays: [A, B] },
    ])
  })

  it("returns nothing when there are no target relays", () => {
    expect(planReplay([product], new Map())).toEqual([])
  })
})

describe("isRelayRateLimit", () => {
  it("matches the wording relays actually send", () => {
    expect(isRelayRateLimit("rate-limited: slow down")).toBe(true)
    expect(isRelayRateLimit("ERROR: too many events from this pubkey")).toBe(true)
    expect(isRelayRateLimit("throttled")).toBe(true)
    expect(isRelayRateLimit("banned: flooding")).toBe(true)
  })

  it("does not treat a kind policy reject as a rate limit", () => {
    // purplepag.es, verbatim. Backing off here would stall the whole catalog
    // on a relay that will never accept a product.
    expect(isRelayRateLimit("blocked: kind 30402 is not allowed")).toBe(false)
    expect(isRelayRateLimit("restricted: this kind is not accepted")).toBe(false)
  })
})

describe("nextPaceMs", () => {
  it("stays at the base gap when nothing rate-limited us", () => {
    expect(nextPaceMs(BASE_PACE_MS, false)).toBe(BASE_PACE_MS)
    expect(nextPaceMs(RATE_LIMIT_PACE_MS, false)).toBe(BASE_PACE_MS)
  })

  it("jumps to 3s, then doubles, and caps at 15s", () => {
    expect(nextPaceMs(BASE_PACE_MS, true)).toBe(RATE_LIMIT_PACE_MS)
    expect(nextPaceMs(RATE_LIMIT_PACE_MS, true)).toBe(6_000)
    expect(nextPaceMs(6_000, true)).toBe(12_000)
    expect(nextPaceMs(12_000, true)).toBe(MAX_PACE_MS)
    expect(nextPaceMs(MAX_PACE_MS, true)).toBe(MAX_PACE_MS)
  })
})

describe("collectCanonicalEvents", () => {
  it("keeps the latest live product and category, not a deleted one", () => {
    const product = ev({
      id: "live",
      kind: KINDS.PRODUCT,
      created_at: 10,
      tags: [
        ["d", "p1"],
        ["title", "Vivo"],
      ],
    })
    const gone = ev({
      id: "dead",
      kind: KINDS.PRODUCT,
      created_at: 5,
      tags: [
        ["d", "p2"],
        ["title", "Muerto"],
      ],
    })
    const del = ev({
      id: "del",
      kind: KINDS.DELETION,
      created_at: 8,
      content: "Producto eliminado",
      tags: [["a", `${KINDS.PRODUCT}:${PK}:p2`]],
    })
    const ids = collectCanonicalEvents([product, gone, del]).map((e) => e.id)
    expect(ids).toContain("live")
    expect(ids).toContain("del")
    expect(ids).not.toContain("dead")
  })

  it("keeps a deletion tombstone and drops a leftover live draft", () => {
    const tomb = ev({
      id: "tomb",
      kind: KINDS.PRODUCT_DRAFT,
      created_at: 20,
      tags: [
        ["d", "p1"],
        ["title", "X"],
        ["deleted", ""],
      ],
    })
    const leftover = ev({
      id: "draft",
      kind: KINDS.PRODUCT_DRAFT,
      created_at: 20,
      tags: [
        ["d", "p2"],
        ["title", "Viejo borrador"],
      ],
    })
    const ids = collectCanonicalEvents([tomb, leftover]).map((e) => e.id)
    expect(ids).toContain("tomb")
    expect(ids).not.toContain("draft")
  })

  it("keeps the newest NIP-65 list", () => {
    const oldList = ev({ id: "old", kind: KINDS.RELAY_LIST, created_at: 1 })
    const newList = ev({ id: "new", kind: KINDS.RELAY_LIST, created_at: 2 })
    expect(collectCanonicalEvents([oldList, newList]).map((e) => e.id)).toEqual([
      "new",
    ])
  })
})

describe("upsertCanonical", () => {
  it("replaces an addressable event by coordinate, not by appending", () => {
    const v1 = ev({
      id: "v1",
      kind: KINDS.PRODUCT,
      created_at: 1,
      tags: [["d", "p1"]],
    })
    const v2 = ev({
      id: "v2",
      kind: KINDS.PRODUCT,
      created_at: 2,
      tags: [["d", "p1"]],
    })
    const next = upsertCanonical([v1], v2)
    expect(next.map((e) => e.id)).toEqual(["v2"])
  })
})

describe("replayLabel", () => {
  it("names catalog events the way the queue already does", () => {
    expect(
      replayLabel(
        ev({
          id: "1",
          kind: KINDS.PRODUCT,
          tags: [["title", "Fernet con Coca"]],
        })
      )
    ).toBe("Fernet con Coca")
    expect(
      replayLabel(
        ev({
          id: "2",
          kind: KINDS.APP_DATA,
          tags: [["d", COUPON_DISCOVERY_D]],
        })
      )
    ).toBe("Anuncio de cupones")
    expect(
      replayLabel(
        ev({
          id: "3",
          kind: KINDS.DELETION,
          content: "Producto eliminado",
        })
      )
    ).toBe("Producto eliminado")
  })
})
