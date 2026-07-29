import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import * as nip44 from "nostr-tools/nip44"
import { describe, expect, it } from "vitest"

import type { SignerPort } from "@/lib/nostr/types"
import {
  DecryptFailedError,
  SignerCannotEncryptError,
  canEncrypt,
  decryptFromSelf,
  encryptToSelf,
} from "./self-encrypt"

/**
 * A signer backed by REAL NIP-44, so these tests exercise the actual scheme
 * rather than a stub that returns its input. nostr-tools is deliberately not
 * quarantined — the eslint config calls it "a pure toolbox".
 */
function realSigner(secret = generateSecretKey()): SignerPort & { pubkey: string } {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    method: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async () => {
      throw new Error("not used")
    },
    nip44: {
      encrypt: async (peer, plaintext) =>
        nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, peer)),
      decrypt: async (peer, ciphertext) =>
        nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, peer)),
    },
  }
}

/** An older extension: signs fine, cannot encrypt. */
const deafSigner: SignerPort = {
  method: "nip07",
  getPublicKey: async () => "b".repeat(64),
  signEvent: async () => {
    throw new Error("not used")
  },
}

describe("canEncrypt", () => {
  it("is true when the signer exposes nip44", () => {
    expect(canEncrypt(realSigner())).toBe(true)
  })

  it("is false for a signer without it, and for no signer at all", () => {
    expect(canEncrypt(deafSigner)).toBe(false)
    expect(canEncrypt(null)).toBe(false)
    expect(canEncrypt(undefined)).toBe(false)
  })
})

describe("encrypt to self", () => {
  it("round-trips through real NIP-44", async () => {
    const signer = realSigner()
    const secret = JSON.stringify({ consumerSecret: "cs_deadbeef" })

    const sealed = await encryptToSelf(signer, signer.pubkey, secret)
    expect(sealed).not.toContain("cs_deadbeef")

    expect(await decryptFromSelf(signer, signer.pubkey, sealed)).toBe(secret)
  })

  it("produces a different ciphertext every time", async () => {
    // NIP-44 nonces are random; identical plaintext must not be linkable.
    const signer = realSigner()
    const a = await encryptToSelf(signer, signer.pubkey, "same")
    const b = await encryptToSelf(signer, signer.pubkey, "same")
    expect(a).not.toBe(b)
  })

  it("survives a long UTF-8 payload", async () => {
    const signer = realSigner()
    const payload = JSON.stringify({ note: "ñandú 🇦🇷 ".repeat(500) })
    const sealed = await encryptToSelf(signer, signer.pubkey, payload)
    expect(await decryptFromSelf(signer, signer.pubkey, sealed)).toBe(payload)
  })

  it("refuses rather than falling back to plaintext", async () => {
    // The whole point: a signer that cannot encrypt must never cause the
    // credentials to be published in the clear.
    await expect(encryptToSelf(deafSigner, "b".repeat(64), "secret")).rejects.toThrow(
      SignerCannotEncryptError
    )
  })
})

describe("decrypt failures", () => {
  it("rejects a payload written by someone else's key", async () => {
    // The realistic case: another app used the same kind-30078 `d` tag.
    const mine = realSigner()
    const theirs = realSigner()
    const sealed = await encryptToSelf(theirs, theirs.pubkey, "not yours")

    await expect(
      decryptFromSelf(mine, mine.pubkey, sealed)
    ).rejects.toThrow(DecryptFailedError)
  })

  it("rejects garbage instead of returning it", async () => {
    const signer = realSigner()
    await expect(
      decryptFromSelf(signer, signer.pubkey, "definitely-not-nip44")
    ).rejects.toThrow(DecryptFailedError)
  })
})
