import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { mintToken } from "@/lib/server/signed-url"
import {
  SESSION_TTL_SECONDS,
  bearerFromHeader,
  mintSessionToken,
  readSessionToken,
} from "@/lib/server/session-token"

const PUBKEY = "a".repeat(64)
const NOW = 1_800_000_000

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}

/** Re-sign a header/payload pair the way the module does, for forgery cases. */
function resign(header: string, payload: string, secret: Uint8Array): string {
  return Buffer.from(hmac(sha256, secret, utf8ToBytes(`${header}.${payload}`))).toString(
    "base64url"
  )
}

describe("mintSessionToken", () => {
  it("round trips", () => {
    const { token } = mintSessionToken(PUBKEY, NOW)
    expect(readSessionToken(token, NOW)).toEqual({
      ok: true,
      claims: { sub: PUBKEY, iat: NOW, exp: NOW + SESSION_TTL_SECONDS },
    })
  })

  it("reports the same expiry it signed", () => {
    expect(mintSessionToken(PUBKEY, NOW).expiresAt).toBe(NOW + SESSION_TTL_SECONDS)
  })

  it("lowercases the pubkey", () => {
    const { token } = mintSessionToken("AB".repeat(32), NOW)
    const result = readSessionToken(token, NOW)
    expect(result.ok && result.claims.sub).toBe("ab".repeat(32))
  })

  it("refuses anything that is not 64 hex — an npub is a caller bug, not input", () => {
    expect(() => mintSessionToken("npub1abc", NOW)).toThrow()
    expect(() => mintSessionToken("a".repeat(63), NOW)).toThrow()
  })

  it("is deterministic, so nothing random crept into the payload", () => {
    expect(mintSessionToken(PUBKEY, NOW).token).toBe(mintSessionToken(PUBKEY, NOW).token)
  })

  it("emits three segments with the canonical HS256 header", () => {
    const [header, , mac] = mintSessionToken(PUBKEY, NOW).token.split(".")
    expect(header).toBe("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    })
    // Full 32-byte tag, not signed-url.ts's 128-bit truncation.
    expect(Buffer.from(mac!, "base64url")).toHaveLength(32)
  })
})

describe("readSessionToken · expiry", () => {
  it("accepts the last second and refuses the boundary itself", () => {
    const { token, expiresAt } = mintSessionToken(PUBKEY, NOW)
    expect(readSessionToken(token, expiresAt - 1).ok).toBe(true)
    // `exp <= now` — RFC 7519 forbids accepting a token ON its expiry.
    expect(readSessionToken(token, expiresAt)).toEqual({ ok: false, reason: "expired" })
  })
})

describe("readSessionToken · forgery", () => {
  it("refuses a tampered payload", () => {
    const [header, , mac] = mintSessionToken(PUBKEY, NOW).token.split(".")
    const evil = b64url(JSON.stringify({ sub: "b".repeat(64), iat: NOW, exp: NOW + 999 }))
    expect(readSessionToken(`${header}.${evil}.${mac}`, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    })
  })

  it("refuses a tampered signature", () => {
    const [header, payload] = mintSessionToken(PUBKEY, NOW).token.split(".")
    const forged = Buffer.alloc(32, 7).toString("base64url")
    expect(readSessionToken(`${header}.${payload}.${forged}`, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    })
  })

  it("refuses a token signed with another secret", () => {
    const [header, payload] = mintSessionToken(PUBKEY, NOW).token.split(".")
    const mac = resign(header!, payload!, utf8ToBytes("not the deployment secret"))
    expect(readSessionToken(`${header}.${payload}.${mac}`, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    })
  })

  it("refuses alg:none, alg:HS512 and a reordered header — before parsing anything", () => {
    const [, payload] = mintSessionToken(PUBKEY, NOW).token.split(".")

    const none = b64url('{"alg":"none","typ":"JWT"}')
    expect(readSessionToken(`${none}.${payload}.`, NOW)).toEqual({
      ok: false,
      reason: "malformed", // empty third segment never even reaches the alg check
    })
    expect(readSessionToken(`${none}.${payload}.AAAA`, NOW)).toEqual({
      ok: false,
      reason: "bad-alg",
    })

    // An HS512 header carrying a genuinely valid HS256 tag over its own bytes:
    // the classic confusion attack, dead on byte equality.
    const hs512 = b64url('{"alg":"HS512","typ":"JWT"}')
    expect(readSessionToken(`${hs512}.${payload}.AAAA`, NOW)).toEqual({
      ok: false,
      reason: "bad-alg",
    })

    // Same two claims, different key order — a JSON-parsing verifier would
    // accept this one.
    const swapped = b64url('{"typ":"JWT","alg":"HS256"}')
    expect(readSessionToken(`${swapped}.${payload}.AAAA`, NOW)).toEqual({
      ok: false,
      reason: "bad-alg",
    })
  })

  it("checks the signature BEFORE parsing the payload", () => {
    // Garbage payload AND a wrong MAC. Reporting "malformed" would mean the
    // parser ran on unauthenticated bytes — this test is what pins the order.
    const [header] = mintSessionToken(PUBKEY, NOW).token.split(".")
    expect(readSessionToken(`${header}.bm90IGpzb24.AAAA`, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    })
  })
})

describe("readSessionToken · shape", () => {
  it("refuses tokens that are not three non-empty segments", () => {
    for (const bad of [null, "", ".", "a.b", "a.b.c.d", "a..c", ".b.c", "a.b."]) {
      expect(readSessionToken(bad, NOW).ok).toBe(false)
    }
  })

  it("does not accept an LNURL proxy token — different shape, different secret", () => {
    const other = mintToken({ u: "https://wallet.example/cb", k: "cb" }, Date.now())
    expect(readSessionToken(other, NOW).ok).toBe(false)
  })
})

/**
 * The claim checks can only be reached with a VALID signature, so these load
 * the module against a known secret and forge properly signed tokens. Asserting
 * them with a junk MAC would pass even if the shape check were deleted — the
 * token would die one step earlier, at `bad-signature`.
 */
describe("readSessionToken · claims, correctly signed", () => {
  const SECRET = "un secreto de prueba"
  const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"

  async function load() {
    vi.resetModules()
    vi.stubEnv("SESSION_JWT_SECRET", SECRET)
    return import("@/lib/server/session-token")
  }

  function signed(payloadJson: string): string {
    const payload = b64url(payloadJson)
    return `${HEADER}.${payload}.${resign(HEADER, payload, utf8ToBytes(SECRET))}`
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("refuses a sub that is not 64 lowercase hex", async () => {
    const { readSessionToken: read } = await load()
    for (const sub of ["z".repeat(64), "a".repeat(63), "A".repeat(64), 42, null]) {
      const token = signed(JSON.stringify({ sub, iat: NOW, exp: NOW + 10 }))
      expect(read(token, NOW)).toEqual({ ok: false, reason: "malformed" })
    }
  })

  it("refuses non-numeric or missing iat/exp", async () => {
    const { readSessionToken: read } = await load()
    for (const claims of [
      { sub: PUBKEY, iat: "hoy", exp: NOW + 10 },
      { sub: PUBKEY, iat: NOW, exp: "mañana" },
      { sub: PUBKEY, iat: NOW },
      { sub: PUBKEY, exp: NOW + 10 },
    ]) {
      expect(read(signed(JSON.stringify(claims)), NOW)).toEqual({
        ok: false,
        reason: "malformed",
      })
    }
  })

  it("refuses a payload that is not a JSON object", async () => {
    const { readSessionToken: read } = await load()
    for (const json of ["[1,2]", '"hola"', "null", "7", "no json"]) {
      expect(read(signed(json), NOW)).toEqual({ ok: false, reason: "malformed" })
    }
  })

  it("accepts a well-formed forgery only under the matching secret", async () => {
    const { mintSessionToken: mintUnderA } = await load()
    const { token } = mintUnderA(PUBKEY, NOW)

    vi.resetModules()
    vi.stubEnv("SESSION_JWT_SECRET", "otro secreto")
    const { readSessionToken: readUnderB } = await import("@/lib/server/session-token")

    expect(readUnderB(token, NOW)).toEqual({ ok: false, reason: "bad-signature" })
  })
})

describe("bearerFromHeader", () => {
  it("takes the token out of a Bearer header, case-insensitively", () => {
    expect(bearerFromHeader("Bearer abc.def.ghi")).toBe("abc.def.ghi")
    expect(bearerFromHeader("bearer   abc.def.ghi  ")).toBe("abc.def.ghi")
  })

  it("returns null for anything else", () => {
    for (const header of [null, "", "Nostr eyJ...", "Bearer", "Bearer   ", "Basic abc"]) {
      expect(bearerFromHeader(header)).toBeNull()
    }
  })
})
