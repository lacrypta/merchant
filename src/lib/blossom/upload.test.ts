import { describe, expect, it } from "vitest"

import {
  blossomServerHostname,
  createBlossomUploadAuthorization,
  parseBlossomBlobDescriptor,
  sha256Hex,
  validateProductImage,
} from "@/lib/blossom/upload"
import type { SignerPort } from "@/lib/nostr/types"

function recordingSigner(
  onTemplate: Parameters<SignerPort["signEvent"]>[0][] = []
): SignerPort {
  return {
    method: "nip07",
    getPublicKey: async () => "f".repeat(64),
    signEvent: async (template) => {
      onTemplate.push(template)
      return {
        ...template,
        id: "a".repeat(64),
        pubkey: "f".repeat(64),
        sig: "b".repeat(128),
      }
    },
  }
}

describe("Blossom upload", () => {
  it("hashes the exact blob bytes", async () => {
    await expect(sha256Hex(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("builds a short-lived BUD-11 token scoped to the hash and servers", async () => {
    const templates: Parameters<SignerPort["signEvent"]>[0][] = []
    const header = await createBlossomUploadAuthorization(
      recordingSigner(templates),
      "c".repeat(64),
      ["https://blossom.band", "https://cdn.satellite.earth"],
      1_800_000_000
    )

    expect(templates).toEqual([
      {
        kind: 24242,
        created_at: 1_799_999_999,
        content: "Upload product image",
        tags: [
          ["t", "upload"],
          ["expiration", "1800000300"],
          ["x", "c".repeat(64)],
          ["server", "blossom.band"],
          ["server", "cdn.satellite.earth"],
        ],
      },
    ])

    expect(header.startsWith("Nostr ")).toBe(true)
    const encoded = header.slice("Nostr ".length)
    const signed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as { kind: number; sig: string }
    expect(signed.kind).toBe(24242)
    expect(signed.sig).toBe("b".repeat(128))
  })

  it("accepts only supported product images under 10 MB", () => {
    expect(
      validateProductImage({ type: "image/webp", size: 1024 } as File)
    ).toBeNull()
    expect(
      validateProductImage({ type: "image/svg+xml", size: 1024 } as File)
    ).toContain("JPG")
    expect(
      validateProductImage({
        type: "image/jpeg",
        size: 11 * 1024 * 1024,
      } as File)
    ).toContain("10 MB")
  })

  it("rejects a descriptor whose hash does not match the uploaded bytes", () => {
    expect(() =>
      parseBlossomBlobDescriptor(
        {
          url: `https://blossom.band/${"d".repeat(64)}.jpg`,
          sha256: "d".repeat(64),
          size: 10,
          type: "image/jpeg",
          uploaded: 1_800_000_000,
        },
        "e".repeat(64)
      )
    ).toThrow("hash distinto")
  })

  it("normalizes Blossom hostnames for BUD-11 server tags", () => {
    expect(blossomServerHostname("https://BLOSSOM.BAND/upload")).toBe(
      "blossom.band"
    )
  })
})
