import { beforeEach, describe, expect, it } from "vitest"

import { __resetCreatedAtState } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"
import {
  MAX_SKU_LENGTH,
  isSkuTaken,
  normalizeSku,
  parseProductEvent,
  productEventBody,
  type Product,
} from "./product"

const PUBKEY = "a".repeat(64)

function product(over: Partial<Product> = {}): Product {
  return {
    d: "pancho",
    posId: 1,
    lifecycle: "published",
    status: "active",
    title: "Pancho",
    summary: undefined,
    description: "",
    price: { amount: 2500, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    type: { kind: "simple", format: "physical" },
    categories: [],
    images: [],
    publishedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    eventId: "e".repeat(64),
    pubkey: PUBKEY,
    unknownTags: [],
    ...over,
  }
}

function event(tags: string[][]): SignedEvent {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: 30402,
    tags: [["d", "pancho"], ["title", "Pancho"], ...tags],
    content: "",
    sig: "s".repeat(128),
  }
}

const tagsOf = (p: Product) => productEventBody(p, new Map(), p.publishedAt).tags
const skuTags = (p: Product) => tagsOf(p).filter((t) => t[0] === "sku")

beforeEach(() => {
  __resetCreatedAtState()
})

describe("normalizeSku", () => {
  it("trims", () => {
    expect(normalizeSku("  ABC-1 ")).toBe("ABC-1")
  })

  it("turns blank into undefined, never an empty string", () => {
    // An empty ["sku", ""] tag on the wire matches nothing but reads as a
    // real value to anyone parsing it.
    expect(normalizeSku("   ")).toBeUndefined()
    expect(normalizeSku("")).toBeUndefined()
    expect(normalizeSku(undefined)).toBeUndefined()
  })

  it("caps the length", () => {
    expect(normalizeSku("x".repeat(500))).toHaveLength(MAX_SKU_LENGTH)
  })
})

describe("the sku tag", () => {
  it("is emitted when set", () => {
    expect(skuTags(product({ sku: "EMP-001" }))).toEqual([["sku", "EMP-001"]])
  })

  it("is ABSENT when unset", () => {
    // A catalog with no SKUs must stay byte-identical to what it published
    // before this field existed, or every product shows as changed.
    expect(skuTags(product())).toEqual([])
  })

  it("is absent when blank", () => {
    expect(skuTags(product({ sku: "  " }))).toEqual([])
  })

  it("round-trips through parse", () => {
    const parsed = parseProductEvent(event([["sku", "EMP-001"]]))
    expect(parsed.ok && parsed.value.sku).toBe("EMP-001")
  })

  it("is undefined when the event has none", () => {
    const parsed = parseProductEvent(event([]))
    expect(parsed.ok && parsed.value.sku).toBeUndefined()
  })

  it("does NOT leak into unknownTags", () => {
    // Before `sku` was modelled, a foreign client's sku tag landed in
    // unknownTags. If it stayed there it would be re-emitted alongside the
    // modelled one and the event would carry the SKU twice.
    const parsed = parseProductEvent(event([["sku", "FOREIGN-9"]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.unknownTags).toEqual([])
    expect(skuTags(parsed.value)).toEqual([["sku", "FOREIGN-9"]])
  })

  it("survives a full parse → build → parse cycle", () => {
    const first = parseProductEvent(event([["sku", "EMP-001"], ["weight", "500"]]))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const rebuilt = event(tagsOf(first.value).slice(2))
    const second = parseProductEvent(rebuilt)
    expect(second.ok && second.value.sku).toBe("EMP-001")
    // The unmodelled tag still round-trips untouched.
    expect(second.ok && second.value.unknownTags).toEqual([["weight", "500"]])
  })
})

describe("isSkuTaken", () => {
  const catalog = [
    product({ d: "a", sku: "EMP-001" }),
    product({ d: "b", sku: "PAN-002" }),
    product({ d: "c" }),
  ]

  it("finds a collision", () => {
    expect(isSkuTaken("EMP-001", catalog)).toBe(true)
  })

  it("ignores the product being edited", () => {
    expect(isSkuTaken("EMP-001", catalog, "a")).toBe(false)
  })

  it("is case-insensitive — stricter than WooCommerce on purpose", () => {
    // Woo would allow both; two references that are indistinguishable off a
    // printed label are a merchant problem, not a database problem.
    expect(isSkuTaken("emp-001", catalog)).toBe(true)
  })

  it("ignores surrounding whitespace", () => {
    expect(isSkuTaken("  EMP-001  ", catalog)).toBe(true)
  })

  it("says no for a free SKU", () => {
    expect(isSkuTaken("NEW-1", catalog)).toBe(false)
  })

  it("never collides with products that have no SKU", () => {
    expect(isSkuTaken("", catalog)).toBe(false)
  })
})
