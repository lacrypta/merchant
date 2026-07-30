import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { describe, expect, it } from "vitest"

import type { SignedEvent } from "@/lib/nostr/types"
import {
  decodeNip98Header,
  nip98UrlsMatch,
  verifyNip98Event,
  type Nip98Expectation,
  type Nip98Verdict,
} from "./nip98"

/** Narrows the verdict union so a failing case can assert on its reason. */
const reasonOf = (verdict: Nip98Verdict): string | null =>
  verdict.ok ? null : verdict.reason

/**
 * Every fixture is a REAL signature from a throwaway key. Hand-written events
 * with a fake `sig` would pass or fail the signature check for the wrong
 * reasons, and the check itself is the thing most worth testing.
 */
const NOW = 1_700_000_000
const URL_ = "https://shop.example/api/coupons"

function token(
  over: {
    url?: string
    method?: string
    payload?: string
    createdAt?: number
    kind?: number
    tags?: string[][]
  } = {}
): SignedEvent {
  const tags = over.tags ?? [
    ["u", over.url ?? URL_],
    ["method", over.method ?? "POST"],
    ...(over.payload ? [["payload", over.payload]] : []),
  ]
  return finalizeEvent(
    {
      kind: over.kind ?? 27235,
      created_at: over.createdAt ?? NOW,
      content: "",
      tags,
    },
    generateSecretKey()
  ) as SignedEvent
}

const expectation = (over: Partial<Nip98Expectation> = {}): Nip98Expectation => ({
  url: URL_,
  method: "POST",
  now: NOW,
  ...over,
})

const hash = (body: string) => bytesToHex(sha256(utf8ToBytes(body)))

describe("decodeNip98Header", () => {
  const encode = (e: SignedEvent) => Buffer.from(JSON.stringify(e)).toString("base64")

  it("reads a standard base64 token", () => {
    const event = token()
    expect(decodeNip98Header(`Nostr ${encode(event)}`)?.id).toBe(event.id)
  })

  it("reads a base64url token, padded or not", () => {
    const event = token()
    const url = Buffer.from(JSON.stringify(event))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(decodeNip98Header(`Nostr ${url}`)?.id).toBe(event.id)
  })

  it("accepts the scheme in any case, with extra whitespace", () => {
    const event = token()
    expect(decodeNip98Header(`  nostr   ${encode(event)}  `)?.id).toBe(event.id)
  })

  it("returns null for anything else", () => {
    expect(decodeNip98Header(null)).toBeNull()
    expect(decodeNip98Header("")).toBeNull()
    expect(decodeNip98Header(`Bearer ${encode(token())}`)).toBeNull()
    expect(decodeNip98Header("Nostr !!!!not-base64!!!!")).toBeNull()
    expect(decodeNip98Header(`Nostr ${Buffer.from('"a string"').toString("base64")}`)).toBeNull()
  })
})

describe("nip98UrlsMatch", () => {
  it("ignores host case and a default port", () => {
    expect(nip98UrlsMatch("https://SHOP.example/api/x", "https://shop.example/api/x")).toBe(true)
    expect(nip98UrlsMatch("https://shop.example:443/api/x", "https://shop.example/api/x")).toBe(
      true
    )
  })

  it("is strict about scheme, path and query", () => {
    expect(nip98UrlsMatch("http://shop.example/api/x", "https://shop.example/api/x")).toBe(false)
    expect(nip98UrlsMatch("https://shop.example/api/x/", "https://shop.example/api/x")).toBe(false)
    expect(
      nip98UrlsMatch("https://shop.example/api/x?nonce=a", "https://shop.example/api/x?nonce=b")
    ).toBe(false)
    expect(
      nip98UrlsMatch("https://shop.example/api/x", "https://shop.example/api/x?nonce=a")
    ).toBe(false)
    expect(nip98UrlsMatch("https://evil.example/api/x", "https://shop.example/api/x")).toBe(false)
  })

  it("rejects a missing or unparseable tag", () => {
    expect(nip98UrlsMatch(undefined, URL_)).toBe(false)
    expect(nip98UrlsMatch("/api/coupons", URL_)).toBe(false)
  })
})

describe("verifyNip98Event", () => {
  it("accepts a well-formed token and returns the author", () => {
    const event = token()
    const verdict = verifyNip98Event(event, expectation())
    expect(verdict).toEqual({ ok: true, pubkey: event.pubkey, eventId: event.id })
  })

  it("accepts a GET token with no payload tag", () => {
    const event = token({ method: "GET" })
    expect(verifyNip98Event(event, expectation({ method: "GET" })).ok).toBe(true)
  })

  it("matches the method case-insensitively", () => {
    expect(verifyNip98Event(token({ method: "post" }), expectation()).ok).toBe(true)
  })

  it("rejects the wrong kind", () => {
    expect(verifyNip98Event(token({ kind: 1 }), expectation())).toEqual({
      ok: false,
      reason: "wrong-kind",
    })
    // 24242 is the blossom token — close enough to be worth naming.
    expect(verifyNip98Event(token({ kind: 24242 }), expectation()).ok).toBe(false)
  })

  it("allows a minute of clock skew in either direction", () => {
    expect(verifyNip98Event(token({ createdAt: NOW - 59 }), expectation()).ok).toBe(true)
    expect(verifyNip98Event(token({ createdAt: NOW + 59 }), expectation()).ok).toBe(true)
    expect(verifyNip98Event(token({ createdAt: NOW - 61 }), expectation())).toEqual({
      ok: false,
      reason: "stale",
    })
    expect(verifyNip98Event(token({ createdAt: NOW + 61 }), expectation())).toEqual({
      ok: false,
      reason: "stale",
    })
  })

  it("rejects a token signed for another URL or method", () => {
    expect(
      reasonOf(verifyNip98Event(token({ url: "https://shop.example/api/other" }), expectation()))
    ).toBe("url-mismatch")
    expect(reasonOf(verifyNip98Event(token({ method: "DELETE" }), expectation()))).toBe(
      "method-mismatch"
    )
  })

  it("binds the token to one exact body", () => {
    const body = JSON.stringify({ couponId: "abc" })
    const event = token({ payload: hash(body) })
    expect(verifyNip98Event(event, expectation({ payloadSha256: hash(body) })).ok).toBe(true)
    expect(
      reasonOf(verifyNip98Event(event, expectation({ payloadSha256: hash('{"couponId":"other"}') })))
    ).toBe("payload-mismatch")
  })

  it("refuses a body with no payload tag — that token would carry any body", () => {
    expect(
      reasonOf(verifyNip98Event(token(), expectation({ payloadSha256: hash("{}") })))
    ).toBe("payload-mismatch")
  })

  it("accepts a payload tag over the empty body, and rejects a wrong one", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    expect(verifyNip98Event(token({ payload: empty }), expectation()).ok).toBe(true)
    expect(reasonOf(verifyNip98Event(token({ payload: hash("{}") }), expectation()))).toBe(
      "payload-mismatch"
    )
  })

  it("rejects a token whose content was changed after signing", () => {
    // The point of verifySignedEvent: nostr-tools stamps a SPREADABLE
    // "already verified" symbol, so a naive check on this object passes.
    const tampered = { ...token(), content: "swapped" }
    expect(verifyNip98Event(tampered, expectation())).toEqual({
      ok: false,
      reason: "bad-signature",
    })
  })

  it("rejects a token whose tags were changed after signing", () => {
    const original = token({ url: "https://evil.example/api/coupons" })
    const tampered = {
      ...original,
      tags: [["u", URL_], ["method", "POST"]],
    }
    expect(reasonOf(verifyNip98Event(tampered, expectation()))).toBe("bad-signature")
  })

  it("rejects structurally broken events before touching the crypto", () => {
    const event = token()
    for (const broken of [
      { ...event, id: "short" },
      { ...event, pubkey: "" },
      { ...event, sig: "nope" },
      { ...event, created_at: Number.NaN },
      { ...event, tags: undefined as unknown as string[][] },
    ]) {
      expect(verifyNip98Event(broken, expectation())).toEqual({
        ok: false,
        reason: "malformed",
      })
    }
  })

  it("lowercases the pubkey it reports, so callers can compare to storage", () => {
    const event = token()
    const upper = { ...event, pubkey: event.pubkey.toUpperCase() }
    // Uppercasing invalidates the signature, so verify the normalisation on the
    // happy path instead: hex from nostr-tools is already lowercase.
    expect(verifyNip98Event(event, expectation())).toMatchObject({
      pubkey: event.pubkey.toLowerCase(),
    })
    expect(verifyNip98Event(upper, expectation()).ok).toBe(false)
  })
})
