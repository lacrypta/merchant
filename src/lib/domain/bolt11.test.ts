import { describe, expect, it } from "vitest"

import { DEFAULT_EXPIRY_SECONDS, decodeInvoice, looksLikeInvoice } from "./bolt11"

/**
 * Fixtures are REAL invoices minted by coinos.io, each requested at a known
 * millisatoshi amount. That is deliberately better than reciting spec vectors
 * from memory: the input amount is ground truth we chose, and the encoding is
 * whatever a production wallet actually emits — including the `n` / `u` / `m`
 * multipliers it picks on our behalf.
 */
const REAL = [
  {
    label: "nano multiplier (21 sat)",
    msat: 21_000,
    pr: "lnbc210n1p4xd3c8sp59hn00w8ygkj0w28qf6arz9zvacwhh0zws0fw08vs2t9uklh36v0qpp536qsluzmd6n7w6wzzsr2r3x3j8emeyxs5ng29tz3kq22qe6luz7shp5as2chaa5ly05u2a5lgchfpg7zcczyw5jtf77r4f9s2gmv59lvp6sxq9z0rgqcqpnrzjq2zdkresdzshu007ddeudy0x7uu4cek0tggr9jmjsrmu9tdna8dyyrn0vsqqw5cqqqqqqqpjqqqqp9sqyg9qxpqysgqu0hcx83nwazhqt4s3uvaft9exk2dau53y93a0vdf45k2u3mw2gkk95lum5x0lpw289a5smm9qzae2hyct6jdc7wa3klz5s67egfdswspquck29",
  },
  {
    label: "micro multiplier (2 500 sat)",
    msat: 2_500_000,
    pr: "lnbc25u1p4xd3c8sp5pztjjtusfkd7gn2djd6jdwuk7y687pxqdu4hv0jrwlt4gud42umqpp5vqejxkgt8r9f7wctp3rmptn6zfrferjt7ancdhrsy6gdggjwvcdqhp5as2chaa5ly05u2a5lgchfpg7zcczyw5jtf77r4f9s2gmv59lvp6sxq9z0rgqcqpnrzjqd3j7hp7gkpjmhcy235lz9a4qdmy44ccvmvkrtj7er0jcsmc4sqe5r3l05qqgdsqqyqqqqqqqqqqthqq2q9qxpqysgq3p2cy7wrma90us2f7ve5zyzj65wt08ccrrt9rp06rztkdh73r0e8grgly0jux7dg75vg70aqcgcyuacvjeeacwyxsarn2ctpu0ksmeqpd7svxf",
  },
  {
    label: "milli multiplier (100 000 sat)",
    msat: 100_000_000,
    pr: "lnbc1m1p4xd3c8sp5wfrqcjkrwp3kx8d3p47az5x6nlfatm9d6a2j09u5nuzcuyltu7qqpp5nln2y0hxy4eemr4wa89vjeetn72tgj28ez7ncjzdgxsv22m6caxshp5as2chaa5ly05u2a5lgchfpg7zcczyw5jtf77r4f9s2gmv59lvp6sxq9z0rgqcqpnrzjqvxlc5mpc7kn2uunukugmzpktv0hmjvyxl2gts4drmfm3krxk4z7sr4zxyqq3pqqqqqqqqlgqqqqqzsqyg9qxpqysgqjy8js3p68qzaec5u8zn3pcersp9g8jhyg2ky0pkxcuy02klqmyhx2dvqf9d4drav0skxcfhjl6wqvv8sn956kt5e3j88fg37q3dwwcgp59nsl5",
  },
] as const

describe("decodeInvoice", () => {
  it.each(REAL)("recovers the exact amount — $label", ({ msat, pr }) => {
    expect(decodeInvoice(pr)?.amountMsat).toBe(msat)
  })

  it("extracts a 32-byte payment hash and description hash", () => {
    const inv = decodeInvoice(REAL[0].pr)
    expect(inv?.paymentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(inv?.descriptionHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("gives every invoice from one LNURL doc the same description hash", () => {
    // All three were minted from the same lnurlp metadata, so LUD-06's
    // `description_hash = sha256(metadata)` must be identical across them.
    // This is exactly the comparison that later tells us whether a provider
    // honoured our `nostr` param or silently fell back to a plain pay.
    const hashes = REAL.map((r) => decodeInvoice(r.pr)?.descriptionHash)
    expect(new Set(hashes).size).toBe(1)
    expect(hashes[0]).toBeTruthy()
  })

  it("reads distinct payment hashes per invoice", () => {
    const hashes = REAL.map((r) => decodeInvoice(r.pr)!.paymentHash)
    expect(new Set(hashes).size).toBe(REAL.length)
  })

  it("parses a plausible timestamp and expiry", () => {
    const inv = decodeInvoice(REAL[0].pr)!
    // Minted while writing this test — sanity-bound it rather than pinning.
    expect(inv.timestamp).toBeGreaterThan(1_700_000_000)
    expect(inv.timestamp).toBeLessThan(4_000_000_000)
    expect(inv.expiresAt).toBe(inv.timestamp + inv.expirySeconds)
    expect(inv.expirySeconds).toBeGreaterThan(0)
  })

  it("defaults expiry to one hour when there is no `x` field", () => {
    // BOLT-11's own no-amount donation vector carries no expiry tag.
    const inv = decodeInvoice(
      "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"
    )
    expect(inv?.expirySeconds).toBe(DEFAULT_EXPIRY_SECONDS)
    expect(inv?.paymentHash).toBe(
      "0001020304050607080900010203040506070809000102030405060708090102"
    )
  })

  it("reports a null amount for an amountless invoice", () => {
    // The single most important rejection: without this, a buyer could settle
    // a 12.000-peso order for one satoshi and we'd call it paid.
    const inv = decodeInvoice(
      "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w"
    )
    expect(inv).not.toBeNull()
    expect(inv?.amountMsat).toBeNull()
  })

  it("returns null for junk instead of throwing", () => {
    for (const junk of [
      "",
      "not an invoice",
      "lnbc",
      "lnbc210n1", // hrp only, no data
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // a bitcoin address
      REAL[0].pr.slice(0, -6), // truncated ⇒ checksum failure
      REAL[0].pr.replace("lnbc210n", "lnbc210x"), // unknown multiplier
    ]) {
      expect(decodeInvoice(junk), junk.slice(0, 24)).toBeNull()
    }
  })

  it("rejects a pico amount that is not a whole millisatoshi", () => {
    // 1p = 0.1 msat. BOLT-11 forbids it, and rounding someone's money is
    // never the right recovery.
    expect(decodeInvoice("lnbc1p1" + "q".repeat(200))).toBeNull()
  })

  it("is case-insensitive, as bech32 requires", () => {
    expect(decodeInvoice(REAL[0].pr.toUpperCase())?.amountMsat).toBe(21_000)
  })
})

describe("looksLikeInvoice", () => {
  it("accepts real invoices and rejects near-misses", () => {
    expect(looksLikeInvoice(REAL[0].pr)).toBe(true)
    expect(looksLikeInvoice(` ${REAL[0].pr} `)).toBe(true)
    expect(looksLikeInvoice("lnbc210n1abc")).toBe(false) // too short
    expect(looksLikeInvoice("https://evil.example/lnbc")).toBe(false)
  })
})
