import { beforeEach, describe, expect, it } from "vitest"

import { __resetCreatedAtState } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"
import {
  WOO_CONFIG_D,
  appDataEventBody,
  buildAppDataEvent,
  isOurWooConfig,
  normalizeStoreUrl,
  parseWooConnection,
  serializeWooConnection,
  type WooConnection,
} from "./woo-config"

const PUBKEY = "a".repeat(64)
const OTHER = "b".repeat(64)

const connection = (over: Partial<WooConnection> = {}): WooConnection => ({
  v: 1,
  storeUrl: "https://tienda.example",
  consumerKey: "ck_123",
  consumerSecret: "cs_456",
  keyPermissions: "read_write",
  storeCurrency: "ARS",
  connectedAt: 1_700_000_000,
  ...over,
})

const event = (over: Partial<SignedEvent> = {}): SignedEvent => ({
  id: "e".repeat(64),
  pubkey: PUBKEY,
  created_at: 1_700_000_000,
  kind: 30078,
  tags: [["d", WOO_CONFIG_D]],
  content: "sealed",
  sig: "s".repeat(128),
  ...over,
})

beforeEach(() => {
  __resetCreatedAtState()
})

describe("normalizeStoreUrl", () => {
  it("adds https and strips path, query and trailing slash", () => {
    expect(normalizeStoreUrl("tienda.example")).toBe("https://tienda.example")
    expect(normalizeStoreUrl("https://tienda.example/")).toBe("https://tienda.example")
    expect(normalizeStoreUrl("https://tienda.example/wp-admin?x=1")).toBe(
      "https://tienda.example"
    )
  })

  it("keeps a port and a subdomain", () => {
    expect(normalizeStoreUrl("https://shop.tienda.example:8443")).toBe(
      "https://shop.tienda.example:8443"
    )
  })

  it("REFUSES plain http", () => {
    // Basic-auth credentials would cross the wire in the clear.
    expect(normalizeStoreUrl("http://tienda.example")).toBeNull()
  })

  it("refuses a hostname with no dot, which is how localhost gets in", () => {
    expect(normalizeStoreUrl("localhost")).toBeNull()
    expect(normalizeStoreUrl("https://localhost:8443")).toBeNull()
  })

  it("refuses junk", () => {
    expect(normalizeStoreUrl("")).toBeNull()
    expect(normalizeStoreUrl("   ")).toBeNull()
    expect(normalizeStoreUrl("javascript:alert(1)")).toBeNull()
  })
})

describe("parseWooConnection", () => {
  it("round-trips", () => {
    const c = connection()
    const parsed = parseWooConnection(serializeWooConnection(c))
    expect(parsed).toEqual({ ok: true, value: c })
  })

  it("discards an unknown version rather than migrating", () => {
    const parsed = parseWooConnection(JSON.stringify({ ...connection(), v: 2 }))
    expect(parsed.ok).toBe(false)
  })

  it("rejects a missing secret instead of defaulting it", () => {
    const rest: Partial<WooConnection> = connection()
    delete rest.consumerSecret
    expect(parseWooConnection(JSON.stringify(rest)).ok).toBe(false)
  })

  it("rejects an http store even if it was somehow stored", () => {
    const parsed = parseWooConnection(
      JSON.stringify(connection({ storeUrl: "http://tienda.example" }))
    )
    expect(parsed.ok).toBe(false)
  })

  it("rejects a currency that is not ISO-4217 shaped", () => {
    expect(
      parseWooConnection(JSON.stringify(connection({ storeCurrency: "pesos" }))).ok
    ).toBe(false)
  })

  it("falls back to read_write for an unknown scope", () => {
    const parsed = parseWooConnection(
      JSON.stringify({ ...connection(), keyPermissions: "banana" })
    )
    expect(parsed.ok && parsed.value.keyPermissions).toBe("read_write")
  })

  it("survives garbage", () => {
    expect(parseWooConnection("{not json").ok).toBe(false)
    expect(parseWooConnection("null").ok).toBe(false)
    expect(parseWooConnection("[]").ok).toBe(false)
  })
})

describe("isOurWooConfig", () => {
  it("accepts our own event", () => {
    expect(isOurWooConfig(event(), PUBKEY, WOO_CONFIG_D)).toBe(true)
  })

  it("rejects another app's d tag on the same kind", () => {
    // Kind 30078 is shared by design. The `d` is the whole fence, and
    // republishing over someone else's would destroy their data.
    expect(
      isOurWooConfig(event({ tags: [["d", "com.example.otherapp"]] }), PUBKEY, WOO_CONFIG_D)
    ).toBe(false)
  })

  it("rejects another author", () => {
    expect(isOurWooConfig(event({ pubkey: OTHER }), PUBKEY, WOO_CONFIG_D)).toBe(false)
  })

  it("rejects another kind", () => {
    expect(isOurWooConfig(event({ kind: 30402 }), PUBKEY, WOO_CONFIG_D)).toBe(false)
  })

  it("rejects an event with no d tag", () => {
    expect(isOurWooConfig(event({ tags: [] }), PUBKEY, WOO_CONFIG_D)).toBe(false)
  })
})

describe("the event", () => {
  it("carries the ciphertext as content and never the secret in a tag", () => {
    const body = appDataEventBody(WOO_CONFIG_D, "SEALED")
    expect(body.content).toBe("SEALED")
    expect(JSON.stringify(body.tags)).not.toContain("cs_")
    expect(body.tags).toContainEqual(["d", WOO_CONFIG_D])
  })

  it("advances created_at on a republish, so the replacement is not shadowed", () => {
    const first = buildAppDataEvent(WOO_CONFIG_D, "a", PUBKEY)
    const second = buildAppDataEvent(WOO_CONFIG_D, "b", PUBKEY)
    expect(second.created_at).toBeGreaterThan(first.created_at)
  })

  it("body is timestamp-free, so diffing never ratchets the clock", () => {
    expect(appDataEventBody(WOO_CONFIG_D, "x")).not.toHaveProperty("created_at")
  })
})
