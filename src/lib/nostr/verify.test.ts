import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { describe, expect, it } from "vitest"

import type { SignedEvent } from "@/lib/nostr/types"
import { verifySignedEvent, verifySignedEventCached } from "./verify"

function signed(overrides: Partial<SignedEvent> = {}): SignedEvent {
  return finalizeEvent(
    {
      kind: 1,
      created_at: 1_800_000_000,
      content: "hola",
      tags: [],
      ...overrides,
    },
    generateSecretKey()
  ) as SignedEvent
}

describe("verifySignedEvent", () => {
  it("accepts a real signature and refuses a forged one", () => {
    const event = signed()
    expect(verifySignedEvent(event)).toBe(true)
    expect(verifySignedEvent({ ...event, sig: "d".repeat(128) })).toBe(false)
  })

  it("refuses an event mutated after signing, memo or no memo", () => {
    // The case the module exists for: nostr-tools stamps a spreadable
    // "already verified" symbol, and `{...event, content}` carries it along.
    const event = signed()
    expect(verifySignedEvent({ ...event, content: "otra cosa" })).toBe(false)
  })
})

describe("verifySignedEventCached", () => {
  it("agrees with the uncached check", () => {
    const event = signed()
    expect(verifySignedEventCached(event)).toBe(true)
    expect(verifySignedEventCached({ ...event, id: "b".repeat(64) })).toBe(false)
  })

  it("does not hand a cached verdict to a different signature", () => {
    const event = signed()
    expect(verifySignedEventCached(event)).toBe(true)
    // `sig` is the half of the event that `id` does not cover, so it has to be
    // part of the key.
    expect(verifySignedEventCached({ ...event, sig: "d".repeat(128) })).toBe(false)
  })

  it("does not hand a cached verdict to different content under the same id", () => {
    // THE trap this module is about. A spread keeps the `id` field, so an
    // id-keyed cache would vouch for content nobody signed — which is
    // nostr-tools' verifiedSymbol bug wearing a different hat. The hash is
    // recomputed before the cache is consulted precisely to stop this.
    const event = signed()
    expect(verifySignedEventCached(event)).toBe(true)
    expect(verifySignedEventCached({ ...event, content: "editado" })).toBe(false)
    expect(verifySignedEventCached({ ...event, tags: [["p", "x".repeat(64)]] })).toBe(false)
    expect(verifySignedEventCached({ ...event, created_at: 999 })).toBe(false)
  })

  it("still answers the genuine event correctly after all those misses", () => {
    const event = signed()
    expect(verifySignedEventCached({ ...event, content: "editado" })).toBe(false)
    expect(verifySignedEventCached(event)).toBe(true)
  })
})
