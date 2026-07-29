import { describe, expect, it } from "vitest"

import {
  EMPTY_SYNC_STATE,
  compactSyncState,
  isOrderSynced,
  parseWooSyncState,
  recordOrderSync,
  recordProductSync,
  serializeWooSyncState,
  skuFor,
  wooOrderIdFor,
  wooProductIdForSku,
  type WooSyncState,
} from "./woo-sync-state"

const state = (over: Partial<WooSyncState> = {}): WooSyncState => ({
  ...EMPTY_SYNC_STATE,
  ...over,
})

describe("isOrderSynced", () => {
  it("is false for an unknown receipt", () => {
    expect(isOrderSynced(EMPTY_SYNC_STATE, "r1", 100)).toBe(false)
  })

  it("is true for a recorded receipt", () => {
    const s = recordOrderSync(EMPTY_SYNC_STATE, { r: "r1", w: 5, at: 100 })
    expect(isOrderSynced(s, "r1", 100)).toBe(true)
  })

  it("is true for anything under the watermark, without an entry", () => {
    // The whole point of the watermark: old orders stay covered after their
    // individual links are dropped.
    expect(isOrderSynced(state({ syncedThrough: 500 }), "old", 400)).toBe(true)
  })

  it("is false just past the watermark", () => {
    expect(isOrderSynced(state({ syncedThrough: 500 }), "new", 501)).toBe(false)
  })

  it("ignores the watermark when the receipt has no timestamp", () => {
    // at === 0 means we could not read it; falling through to the id list is
    // the safe reading — worst case we re-check, never silently skip.
    expect(isOrderSynced(state({ syncedThrough: 500 }), "x", 0)).toBe(false)
  })
})

describe("recordOrderSync", () => {
  it("is idempotent — the guard against double-creating an order", () => {
    const once = recordOrderSync(EMPTY_SYNC_STATE, { r: "r1", w: 5, at: 100 })
    const twice = recordOrderSync(once, { r: "r1", w: 99, at: 100 })
    expect(twice.orders).toHaveLength(1)
    expect(wooOrderIdFor(twice, "r1")).toBe(5)
    expect(twice).toBe(once)
  })

  it("keeps distinct receipts", () => {
    let s = recordOrderSync(EMPTY_SYNC_STATE, { r: "r1", w: 5, at: 100 })
    s = recordOrderSync(s, { r: "r2", w: 6, at: 200 })
    expect(s.orders).toHaveLength(2)
  })
})

describe("product links", () => {
  it("upserts on the product d, never duplicating", () => {
    let s = recordProductSync(EMPTY_SYNC_STATE, { d: "p1", sku: "A-1", w: 10 })
    s = recordProductSync(s, { d: "p1", sku: "A-2", w: 11 })
    expect(s.products).toHaveLength(1)
    expect(skuFor(s, "p1")).toBe("A-2")
  })

  it("resolves a woo id from a SKU, case-insensitively", () => {
    const s = recordProductSync(EMPTY_SYNC_STATE, { d: "p1", sku: "EMP-001", w: 10 })
    expect(wooProductIdForSku(s, "emp-001")).toBe(10)
    expect(wooProductIdForSku(s, "nope")).toBeUndefined()
  })
})

describe("compactSyncState", () => {
  const withOrders = state({
    orders: [
      { r: "a", w: 1, at: 100 },
      { r: "b", w: 2, at: 200 },
      { r: "c", w: 3, at: 300 },
    ],
  })

  it("advances to the newest when everything is synced", () => {
    const s = compactSyncState(withOrders, Number.POSITIVE_INFINITY)
    expect(s.syncedThrough).toBe(300)
    expect(s.orders).toHaveLength(0)
  })

  it("NEVER passes an unsynced order", () => {
    // Passing it would mark a real, unsent order as handled forever — it would
    // never reach WooCommerce and nobody would know.
    const s = compactSyncState(withOrders, 250)
    expect(s.syncedThrough).toBe(249)
    expect(s.orders.map((o) => o.r)).toEqual(["c"])
  })

  it("keeps every order still covered by its own link", () => {
    const s = compactSyncState(withOrders, 150)
    for (const o of withOrders.orders) {
      expect(isOrderSynced(s, o.r, o.at)).toBe(true)
    }
  })

  it("stops just short when the oldest unsynced order is the first one", () => {
    // The watermark lands at 99: true (nothing exists before 100) and it
    // covers nothing, so every link is kept.
    const s = compactSyncState(withOrders, 100)
    expect(s.syncedThrough).toBe(99)
    expect(s.orders).toHaveLength(3)
    expect(isOrderSynced(s, "a", 100)).toBe(true)
  })

  it("never moves backwards", () => {
    const s = compactSyncState(state({ syncedThrough: 900 }), 50)
    expect(s.syncedThrough).toBe(900)
  })
})

describe("parse", () => {
  it("round-trips", () => {
    const s = recordOrderSync(
      recordProductSync(EMPTY_SYNC_STATE, { d: "p1", sku: "A", w: 3 }),
      { r: "r1", w: 5, at: 100 }
    )
    expect(parseWooSyncState(serializeWooSyncState(s))).toEqual(s)
  })

  it("discards an unknown version rather than guessing", () => {
    // Losing the record costs a duplicate scan against WooCommerce.
    // Misreading it costs duplicate orders in the merchant's books.
    expect(parseWooSyncState(JSON.stringify({ v: 2, orders: [{ r: "x", w: 1, at: 1 }] })))
      .toEqual(EMPTY_SYNC_STATE)
  })

  it("survives garbage", () => {
    expect(parseWooSyncState("{not json")).toEqual(EMPTY_SYNC_STATE)
    expect(parseWooSyncState("[]")).toEqual(EMPTY_SYNC_STATE)
    expect(parseWooSyncState("null")).toEqual(EMPTY_SYNC_STATE)
  })

  it("drops malformed entries but keeps the good ones", () => {
    const parsed = parseWooSyncState(
      JSON.stringify({
        v: 1,
        syncedThrough: 10,
        orders: [{ r: "ok", w: 1, at: 5 }, { r: "bad" }, null],
        products: [{ d: "p", sku: "s", w: 2 }, { d: "x" }],
      })
    )
    expect(parsed.orders).toEqual([{ r: "ok", w: 1, at: 5 }])
    expect(parsed.products).toEqual([{ d: "p", sku: "s", w: 2 }])
  })
})
