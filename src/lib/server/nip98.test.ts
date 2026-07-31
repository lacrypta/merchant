import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { nowSeconds } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"
import { MAX_BODY_BYTES, __resetNip98Replay, externalUrl, requireNip98 } from "./nip98"

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

function tokenFor(url: string, method: string, payload?: string): string {
  const tags: string[][] = [
    ["u", url],
    ["method", method],
  ]
  if (payload) tags.push(["payload", payload])
  const event = finalizeEvent(
    { kind: 27235, created_at: nowSeconds(), content: "", tags },
    generateSecretKey()
  ) as SignedEvent
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`
}

async function sha256Hex(body: string): Promise<string> {
  const { sha256 } = await import("@noble/hashes/sha2.js")
  const { bytesToHex, utf8ToBytes } = await import("@noble/hashes/utils.js")
  return bytesToHex(sha256(utf8ToBytes(body)))
}

beforeEach(() => {
  __resetNip98Replay()
  delete process.env.NEXT_PUBLIC_APP_URL
})

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
})

describe("externalUrl", () => {
  it("uses the request URL when nothing is configured or forwarded", () => {
    const request = new Request("https://shop.example/api/coupons?x=1")
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons?x=1")
  })

  it("honours forwarded headers when no origin is configured", () => {
    const request = new Request("http://127.0.0.1:4321/api/coupons", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "shop.example" },
    })
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons")
  })

  it("takes only the first value of a chained forwarded header", () => {
    const request = new Request("http://127.0.0.1:4321/api/coupons", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "shop.example, inner.local",
      },
    })
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons")
  })

  it("IGNORES forwarded headers once an origin is configured", () => {
    // The attack this closes: a forged x-forwarded-host would otherwise make a
    // token signed for someone else's deployment authenticate against ours.
    process.env.NEXT_PUBLIC_APP_URL = "https://shop.example"
    const request = new Request("http://127.0.0.1:4321/api/coupons?a=b", {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    })
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons?a=b")
  })

  it("keeps the path and query from the request, never from a header", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://shop.example/ignored/path"
    const request = new Request("https://internal/api/coupons/claim?nonce=abc")
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons/claim?nonce=abc")
  })

  it("falls back to the headers when the configured origin is unparseable", () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a url"
    const request = new Request("https://shop.example/api/coupons")
    expect(externalUrl(request)).toBe("https://shop.example/api/coupons")
  })
})

describe("requireNip98", () => {
  const URL_ = "https://shop.example/api/coupons"

  it("authenticates a GET with no body", async () => {
    const request = new Request(URL_, {
      headers: { authorization: tokenFor(URL_, "GET") },
    })
    const auth = await requireNip98(request)
    expect(auth.ok).toBe(true)
    if (auth.ok) {
      expect(auth.pubkey).toMatch(/^[0-9a-f]{64}$/)
      expect(auth.rawBody).toBe("")
    }
  })

  it("authenticates a POST and hands the body back unparsed", async () => {
    const body = JSON.stringify({ couponId: "abc" })
    const request = new Request(URL_, {
      method: "POST",
      body,
      headers: { authorization: tokenFor(URL_, "POST", await sha256Hex(body)) },
    })
    const auth = await requireNip98(request)
    expect(auth.ok && auth.rawBody).toBe(body)
  })

  it("rejects a missing header", async () => {
    const auth = await requireNip98(new Request(URL_))
    expect(auth).toMatchObject({ ok: false, status: 401, reason: "missing" })
  })

  it("rejects a token signed for a different body", async () => {
    const request = new Request(URL_, {
      method: "POST",
      body: JSON.stringify({ couponId: "swapped" }),
      headers: {
        authorization: tokenFor(URL_, "POST", await sha256Hex('{"couponId":"abc"}')),
      },
    })
    expect(await requireNip98(request)).toMatchObject({
      ok: false,
      status: 401,
      reason: "payload-mismatch",
    })
  })

  it("rejects a token signed for a different path", async () => {
    const request = new Request(URL_, {
      headers: { authorization: tokenFor("https://shop.example/api/coupons/mint", "GET") },
    })
    expect(await requireNip98(request)).toMatchObject({ reason: "url-mismatch" })
  })

  it("refuses a body over the size cap", async () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1)
    const request = new Request(URL_, {
      method: "POST",
      body,
      headers: { authorization: tokenFor(URL_, "POST", await sha256Hex(body)) },
    })
    expect(await requireNip98(request)).toMatchObject({ ok: false, status: 413 })
  })

  it("refuses an absurd Authorization header without parsing it", async () => {
    const request = new Request(URL_, {
      headers: { authorization: `Nostr ${"A".repeat(9000)}` },
    })
    expect(await requireNip98(request)).toMatchObject({
      ok: false,
      status: 401,
      reason: "too-large",
    })
  })

  it("honours a token once and then treats it as a replay", async () => {
    const authorization = tokenFor(URL_, "GET")
    expect((await requireNip98(new Request(URL_, { headers: { authorization } }))).ok).toBe(true)
    expect(await requireNip98(new Request(URL_, { headers: { authorization } }))).toMatchObject({
      ok: false,
      reason: "replay",
    })
  })

  it("does not confuse two different tokens for the same request", async () => {
    expect(
      (await requireNip98(new Request(URL_, { headers: { authorization: tokenFor(URL_, "GET") } })))
        .ok
    ).toBe(true)
    expect(
      (await requireNip98(new Request(URL_, { headers: { authorization: tokenFor(URL_, "GET") } })))
        .ok
    ).toBe(true)
  })
})
