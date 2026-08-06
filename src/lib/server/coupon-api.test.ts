import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { nowSeconds } from "@/lib/nostr/created-at"
import type { SignedEvent } from "@/lib/nostr/types"
import { MAX_BODY_BYTES } from "@/lib/server/http"
import { __resetNip98Replay } from "@/lib/server/nip98"
import { mintSessionToken } from "@/lib/server/session-token"
import { parseClaimedOrder, requireAuth } from "./coupon-api"

/**
 * `requireAuth` is the single choke point for every coupon route, and it now
 * speaks two schemes. What these pin down is that the two agree on WHO the
 * caller is and on the ORDER in which a request is refused — a bearer path that
 * 401s where the NIP-98 path 413s would be a difference nobody would notice
 * until a POS integrator hit it.
 */

const URL_ = "https://shop.example/api/coupons"
const METHODS = "GET, POST"
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

function nip98(url: string, method: string, secret = generateSecretKey()) {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: nowSeconds(),
      content: "",
      tags: [
        ["u", url],
        ["method", method],
        // Every token must be a distinct event or the replay cache refuses it.
        ["nonce", String(Math.random())],
      ],
    },
    secret
  ) as SignedEvent
  return {
    header: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
    pubkey: getPublicKey(secret),
  }
}

/** Read a NextResponse the way a client would. */
async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  __resetNip98Replay()
  delete process.env.NEXT_PUBLIC_APP_URL
})

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
})

describe("requireAuth · Bearer", () => {
  it("authenticates and hands the body back untouched", async () => {
    const pubkey = "a".repeat(64)
    const { token } = mintSessionToken(pubkey, nowSeconds())
    const payload = JSON.stringify({ name: "Café gratis" })

    const auth = await requireAuth(
      new Request(URL_, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: payload,
      }),
      METHODS
    )

    expect(auth).toEqual({ pubkey, rawBody: payload })
  })

  it("says the session expired, distinctly, so the log can tell", async () => {
    // Minted thirteen hours ago, so its twelve-hour window closed an hour back.
    const { token } = mintSessionToken("b".repeat(64), nowSeconds() - 13 * 60 * 60)

    const auth = await requireAuth(
      new Request(URL_, { headers: { authorization: `Bearer ${token}` } }),
      METHODS
    )

    expect("response" in auth).toBe(true)
    if (!("response" in auth)) return
    expect(auth.response.status).toBe(401)
    expect(await body(auth.response)).toMatchObject({ reason: "session-expired" })
  })

  it("collapses every invalid token into one answer", async () => {
    for (const token of ["garbage", "a.b.c", `${"x".repeat(40)}.y.z`]) {
      const auth = await requireAuth(
        new Request(URL_, { headers: { authorization: `Bearer ${token}` } }),
        METHODS
      )
      expect("response" in auth).toBe(true)
      if (!("response" in auth)) return
      expect(auth.response.status).toBe(401)
      expect(await body(auth.response)).toMatchObject({ reason: "session-invalid" })
    }
  })

  it("refuses an oversized body with 413, exactly like the NIP-98 path", async () => {
    const { token } = mintSessionToken("c".repeat(64), nowSeconds())
    const auth = await requireAuth(
      new Request(URL_, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "x".repeat(MAX_BODY_BYTES + 1),
      }),
      METHODS
    )

    expect("response" in auth).toBe(true)
    if (!("response" in auth)) return
    expect(auth.response.status).toBe(413)
  })

  it("refuses an oversized header before it tries to verify it", async () => {
    const auth = await requireAuth(
      new Request(URL_, { headers: { authorization: `Bearer ${"x".repeat(9_000)}` } }),
      METHODS
    )
    expect("response" in auth).toBe(true)
    if (!("response" in auth)) return
    expect(auth.response.status).toBe(401)
  })
})

describe("requireAuth · NIP-98 still works", () => {
  it("authenticates a signed event — the regression that matters most", async () => {
    const { header, pubkey } = nip98(URL_, "GET")
    const auth = await requireAuth(new Request(URL_, { headers: { authorization: header } }), METHODS)
    expect(auth).toEqual({ pubkey, rawBody: "" })
  })

  it("reports `missing` when there is no Authorization at all", async () => {
    const auth = await requireAuth(new Request(URL_), METHODS)
    expect("response" in auth).toBe(true)
    if (!("response" in auth)) return
    expect(auth.response.status).toBe(401)
    expect(await body(auth.response)).toMatchObject({ reason: "missing" })
  })

  it("does not fall back to NIP-98 when a Bearer is present but bad", async () => {
    // The scheme decides. Falling through would mean reading the body twice.
    const auth = await requireAuth(
      new Request(URL_, { headers: { authorization: "Bearer nope" } }),
      METHODS
    )
    expect("response" in auth).toBe(true)
    if (!("response" in auth)) return
    expect(await body(auth.response)).toMatchObject({ reason: "session-invalid" })
  })
})

describe("parseClaimedOrder", () => {
  const order = (overrides: Partial<SignedEvent> = {}): SignedEvent => {
    const template = {
      kind: 9734,
      created_at: nowSeconds(),
      content: "",
      tags: [
        ["p", "b".repeat(64)],
        ["coupon", "an-id", "percent", "Promo"],
      ] as string[][],
      ...overrides,
    }
    const signed = finalizeEvent(template, generateSecretKey()) as SignedEvent
    return { ...signed, ...(overrides.sig ? { sig: overrides.sig } : {}) }
  }

  it("accepts a signed zap request that names a coupon", () => {
    const event = order()
    expect(parseClaimedOrder(event, 0)).toEqual({ event, amountMsat: 0 })
  })

  it("accepts the event as a JSON string, the way a POS may send it", () => {
    const event = order()
    // Compared by id, not by identity: a JSON round trip drops nostr-tools'
    // non-enumerable "already verified" symbol, which is the point of
    // verifySignedEvent rebuilding the canonical fields.
    expect(parseClaimedOrder(JSON.stringify(event), 21_000)).toMatchObject({
      event: { id: event.id, sig: event.sig },
      amountMsat: 21_000,
    })
  })

  it("rejects a forged signature", () => {
    expect(parseClaimedOrder(order({ sig: "d".repeat(128) }), 0)).toBeUndefined()
  })

  it("rejects anything that is not a zap request", () => {
    expect(parseClaimedOrder(order({ kind: 1 }), 0)).toBeUndefined()
  })

  it("rejects a request that names no coupon", () => {
    expect(parseClaimedOrder(order({ tags: [["p", "b".repeat(64)]] }), 0)).toBeUndefined()
  })

  it("rejects an oversized request", () => {
    const fat = order({ tags: [["coupon", "an-id", "percent", "x".repeat(9000)]] })
    expect(parseClaimedOrder(fat, 0)).toBeUndefined()
  })

  it("rejects an amount that is missing, negative or not an integer", () => {
    expect(parseClaimedOrder(order(), undefined)).toBeUndefined()
    expect(parseClaimedOrder(order(), -1)).toBeUndefined()
    expect(parseClaimedOrder(order(), 1.5)).toBeUndefined()
    expect(parseClaimedOrder(order(), "1000")).toBeUndefined()
  })

  it("returns undefined when no order was sent at all", () => {
    expect(parseClaimedOrder(undefined, undefined)).toBeUndefined()
    expect(parseClaimedOrder(null, 0)).toBeUndefined()
    expect(parseClaimedOrder("no es json", 0)).toBeUndefined()
  })
})
