import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { describe, expect, it } from "vitest"

import { decodeInvoice } from "./bolt11"
import { KINDS } from "./kinds"
import {
  URL_BUDGET,
  buildCallbackUrl,
  canonicalItemsHash,
  fitZapRequest,
  matchReceipt,
  parseOrder,
  classifyNostrParam,
  planComment,
  reconcilePayee,
  settle,
  signZapRequest,
  verifyPreimage,
  type BuildOrderInput,
  type Order,
  type OrderLine,
  type Proof,
} from "./order"
import type { SignedEvent } from "@/lib/nostr/types"

const MERCHANT = "a".repeat(64)
const CALLBACK = "https://coinos.io/api/lnurl/8c968cb6-3666-4b76-bf36-b46383eb88c0"
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol"]
const NOW_S = 1_785_000_000
const NOW_MS = NOW_S * 1000

/** A real 21-sat invoice, so payment hashes and amounts are genuine. */
const REAL_PR =
  "lnbc210n1p4xd3c8sp59hn00w8ygkj0w28qf6arz9zvacwhh0zws0fw08vs2t9uklh36v0qpp536qsluzmd6n7w6wzzsr2r3x3j8emeyxs5ng29tz3kq22qe6luz7shp5as2chaa5ly05u2a5lgchfpg7zcczyw5jtf77r4f9s2gmv59lvp6sxq9z0rgqcqpnrzjq2zdkresdzshu007ddeudy0x7uu4cek0tggr9jmjsrmu9tdna8dyyrn0vsqqw5cqqqqqqqpjqqqqp9sqyg9qxpqysgqu0hcx83nwazhqt4s3uvaft9exk2dau53y93a0vdf45k2u3mw2gkk95lum5x0lpw289a5smm9qzae2hyct6jdc7wa3klz5s67egfdswspquck29"
const REAL_HASH = decodeInvoice(REAL_PR)!.paymentHash!

function lines(n: number): OrderLine[] {
  return Array.from({ length: n }, (_, i) => ({
    d: `${String(i).padStart(8, "0")}-1111-4222-8333-444444444444`,
    qty: (i % 3) + 1,
    title: `Producto ${i}`,
    unitAmount: 7300 + i,
    currency: "ARS",
  }))
}

function input(over: Partial<BuildOrderInput> = {}): BuildOrderInput {
  return {
    merchantPubkey: MERCHANT,
    lines: lines(3),
    relays: RELAYS,
    callbackUrlForSizing: CALLBACK,
    amountMsat: 21_000,
    comment: null,
    createdAt: NOW_S,
    ...over,
  }
}

function makeOrder(over: Partial<Order> = {}): Order {
  const l = (over.lines ?? lines(2)) as OrderLine[]
  const fitted = fitZapRequest(input({ lines: l }))
  const zapRequest = signZapRequest(fitted.template)
  return {
    v: 1,
    id: zapRequest.id,
    status: "awaiting_payment",
    createdAt: NOW_S,
    updatedAt: NOW_MS,
    payee: {
      merchantPubkey: MERCHANT,
      lud16: "shop@coinos.io",
      callbackToken: "tok",
      callbackOrigin: "https://coinos.io",
      nostrPubkey: "b".repeat(64),
      metadataSha256: "c".repeat(64),
      commentAllowed: 512,
      minSendable: 1000,
      maxSendable: 1e11,
    },
    lines: l,
    itemsHash: fitted.itemsHash,
    zapRequest,
    itemsFidelity: fitted.fidelity,
    commentSent: "full",
    invoices: [],
    proofs: [],
    anomalies: [],
    ...over,
  }
}

function invoice(amountMsat: number, paymentHash = REAL_HASH) {
  return {
    pr: REAL_PR,
    paymentHash,
    amountMsat,
    bolt11AmountMsat: 21_000,
    hardExpiresAt: NOW_MS + 3_600_000,
    displayExpiresAt: NOW_MS + 600_000,
    issuedAt: NOW_MS,
    verifyToken: "v",
    nostrParamStatus: "honored" as const,
    state: "live" as const,
    quote: { totalMsat: amountMsat, perCurrency: [], rateAsOf: NOW_MS, quotedAt: NOW_MS },
  }
}

describe("canonicalItemsHash", () => {
  it("is independent of line order", () => {
    const l = lines(5)
    expect(canonicalItemsHash([...l].reverse())).toBe(canonicalItemsHash(l))
  })

  it("changes when quantity, price or currency changes", () => {
    const base = canonicalItemsHash(lines(2))
    const l = lines(2)
    expect(canonicalItemsHash([{ ...l[0]!, qty: 9 }, l[1]!])).not.toBe(base)
    expect(canonicalItemsHash([{ ...l[0]!, unitAmount: 1 }, l[1]!])).not.toBe(base)
    expect(canonicalItemsHash([{ ...l[0]!, currency: "USD" }, l[1]!])).not.toBe(base)
  })

  it("ignores the display title, which is not part of the deal", () => {
    const l = lines(2)
    expect(canonicalItemsHash([{ ...l[0]!, title: "otro" }, l[1]!])).toBe(
      canonicalItemsHash(l)
    )
  })
})

describe("fitZapRequest", () => {
  const tagsOf = (t: { tags: string[][] }, name: string) =>
    t.tags.filter((x) => x[0] === name)

  it("uses full fidelity for an ordinary cart", () => {
    const f = fitZapRequest(input({ lines: lines(3) }))
    expect(f.fidelity).toBe(1)
    expect(tagsOf(f.template, "item")).toHaveLength(3)
    expect(tagsOf(f.template, "item")[0]).toEqual([
      "item",
      lines(3)[0]!.d,
      "1",
      "7300",
      "ARS",
    ])
  })

  it("never exceeds the URL budget, however large the cart", () => {
    for (const n of [1, 10, 19, 25, 40, 200]) {
      const f = fitZapRequest(input({ lines: lines(n) }))
      const url = buildCallbackUrl(
        CALLBACK,
        21_000,
        { ...f.template, id: "0".repeat(64), pubkey: "0".repeat(64), sig: "0".repeat(128) },
        null
      )
      expect(url.length, `n=${n} fidelity=${f.fidelity}`).toBeLessThanOrEqual(URL_BUDGET)
    }
  })

  it("degrades gracefully as the cart grows", () => {
    const small = fitZapRequest(input({ lines: lines(3) })).fidelity
    const huge = fitZapRequest(input({ lines: lines(200) })).fidelity
    expect(small).toBeLessThan(huge)
    expect(huge).toBe(4)
  })

  it("ALWAYS commits to the basket via items_hash, even at full degradation", () => {
    // This is what makes truncating the item tags safe.
    const l = lines(200)
    const f = fitZapRequest(input({ lines: l }))
    expect(tagsOf(f.template, "item")).toHaveLength(0)
    expect(tagsOf(f.template, "items_hash")[0]![1]).toBe(canonicalItemsHash(l))
    expect(tagsOf(f.template, "items_count")[0]![1]).toBe(
      String(l.reduce((n, x) => n + x.qty, 0))
    )
  })

  it("emits exactly one `p` tag and no `amount` tag", () => {
    // NIP-57 Appendix A requires exactly one `p`; omitting `amount` (D1) is
    // what lets us re-invoice at a new rate under the same order id.
    const f = fitZapRequest(input())
    expect(tagsOf(f.template, "p")).toHaveLength(1)
    expect(tagsOf(f.template, "amount")).toHaveLength(0)
    expect(tagsOf(f.template, "e")).toHaveLength(0)
    expect(tagsOf(f.template, "relays")).toHaveLength(1)
  })

  it("adds an `a` tag only for a single-product cart", () => {
    const one = fitZapRequest(input({ lines: lines(1) }))
    expect(tagsOf(one.template, "a")[0]![1]).toBe(
      `${KINDS.PRODUCT}:${MERCHANT}:${lines(1)[0]!.d}`
    )
    // Multiple `a` tags would be copied into the public receipt and render as
    // N separate full-amount zaps in every zap-aware client.
    expect(tagsOf(fitZapRequest(input({ lines: lines(4) })).template, "a")).toHaveLength(0)
  })

  it("caps the relay hint list at four", () => {
    const many = ["wss://a.co", "wss://b.co", "wss://c.co", "wss://d.co", "wss://e.co"]
    const f = fitZapRequest(input({ relays: many }))
    expect(tagsOf(f.template, "relays")[0]!.slice(1)).toHaveLength(4)
  })

  it("summarises the order in content without embedding JSON", () => {
    const f = fitZapRequest(input({ lines: lines(2), buyerNote: "sin cebolla" }))
    expect(f.template.content).toContain("Pedido")
    expect(f.template.content).toContain("ARS")
    expect(f.template.content).toContain("sin cebolla")
    expect(f.template.content).not.toContain("{")
  })
})

describe("signZapRequest", () => {
  it("produces a verifiable event whose id is the order number", () => {
    const f = fitZapRequest(input())
    const signed = signZapRequest(f.template)
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.kind).toBe(KINDS.ZAP_REQUEST)
    // Re-serialising the persisted event must reproduce the same id — this is
    // exactly what survives a page refresh.
    expect(parseOrder(JSON.stringify(makeOrder()), NOW_MS)).not.toBeNull()
  })

  it("uses a fresh key each time, so orders are not linkable", () => {
    const f = fitZapRequest(input())
    expect(signZapRequest(f.template).pubkey).not.toBe(signZapRequest(f.template).pubkey)
  })
})

describe("planComment", () => {
  const id = "f".repeat(64)

  it("sends the full reference when there is room", () => {
    expect(planComment(512, id)).toEqual({ comment: `Pedido ${id}`, sent: "full" })
  })

  it("drops the prefix before it truncates the id", () => {
    expect(planComment(64, id)).toEqual({ comment: id, sent: "full" })
  })

  it("truncates to a still-unique prefix when it must", () => {
    const r = planComment(32, id)
    expect(r.sent).toBe("truncated")
    expect(r.comment).toHaveLength(32)
  })

  it("sends NO comment param when the server allows none", () => {
    // Sending one anyway violates LUD-12 and makes some servers reject the
    // entire callback.
    expect(planComment(0, id)).toEqual({ comment: null, sent: "omitted" })
    expect(planComment(Number.NaN, id)).toEqual({ comment: null, sent: "omitted" })
    expect(planComment(8, id)).toEqual({ comment: null, sent: "omitted" })
  })
})

describe("buildCallbackUrl", () => {
  it("encodes spaces as %20, never as +", () => {
    // URLSearchParams would emit `+`, which more than one LNURL server decodes
    // literally.
    const url = buildCallbackUrl(CALLBACK, 21_000, null, "Pedido con espacios")
    expect(url).toContain("%20")
    expect(url).not.toContain("+")
  })

  it("appends with & when the callback already has a query", () => {
    expect(buildCallbackUrl("https://x.co/cb?k=1", 5, null, null)).toBe(
      "https://x.co/cb?k=1&amount=5"
    )
  })
})

describe("settle", () => {
  const proof = (over: Partial<Proof> = {}): Proof => ({
    kind: "lud21",
    at: NOW_MS,
    paymentHash: REAL_HASH,
    ...over,
  })

  it("moves to paid and marks the invoice settled", () => {
    const o = settle(makeOrder({ invoices: [invoice(21_000)] }), proof(), NOW_MS)
    expect(o.status).toBe("paid")
    expect(o.paidAt).toBe(NOW_MS)
    expect(o.invoices[0]!.state).toBe("settled")
  })

  it("is idempotent and never regresses from paid", () => {
    let o = settle(makeOrder({ invoices: [invoice(21_000)] }), proof(), NOW_MS)
    o = settle(o, proof({ kind: "manual", paymentHash: null }), NOW_MS + 10)
    expect(o.status).toBe("paid")
    expect(o.proofs).toHaveLength(2)
  })

  it("treats a manual claim as provisional, and upgrades it on real proof", () => {
    let o = makeOrder({ invoices: [invoice(21_000)] })
    o = settle(o, proof({ kind: "manual", paymentHash: null }), NOW_MS)
    expect(o.status).toBe("manually_confirmed")
    o = settle(o, proof({ kind: "receipt" }), NOW_MS + 5)
    expect(o.status).toBe("paid")
  })

  it("flags a double payment instead of hiding it", () => {
    let o = settle(makeOrder({ invoices: [invoice(21_000)] }), proof(), NOW_MS)
    o = settle(o, proof({ paymentHash: "d".repeat(64) }), NOW_MS + 1)
    expect(o.anomalies).toContainEqual({
      kind: "double-paid",
      paymentHashes: [REAL_HASH, "d".repeat(64)],
    })
  })

  it("does not duplicate the double-paid anomaly on a third proof", () => {
    let o = settle(makeOrder({ invoices: [invoice(21_000)] }), proof(), NOW_MS)
    o = settle(o, proof({ paymentHash: "d".repeat(64) }), NOW_MS + 1)
    o = settle(o, proof({ paymentHash: "e".repeat(64) }), NOW_MS + 2)
    expect(o.anomalies.filter((a) => a.kind === "double-paid")).toHaveLength(1)
  })

  it("flags an underpayment when a stale cheaper invoice settles", () => {
    // Paying an expired invoice is still paying — but the merchant is owed the
    // difference and must be told, not quietly short-changed.
    const o = makeOrder({
      invoices: [invoice(21_000, REAL_HASH), invoice(30_000, "f".repeat(64))],
    })
    const settled = settle(o, proof(), NOW_MS)
    expect(settled.status).toBe("paid")
    expect(settled.anomalies).toContainEqual({
      kind: "underpaid",
      expectedMsat: 30_000,
      paidMsat: 21_000,
    })
  })

  it("refuses to resurrect a cancelled order", () => {
    const o = makeOrder({ status: "cancelled", invoices: [invoice(21_000)] })
    expect(settle(o, proof(), NOW_MS)).toBe(o)
  })
})

describe("verifyPreimage", () => {
  it("accepts a preimage whose sha256 is the payment hash", () => {
    // sha256("") — a known pair, so this asserts the arithmetic, not itself.
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    expect(verifyPreimage("", hash)).toBe(false) // empty is not 64 hex
    const preimage = "00".repeat(32)
    const known = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
    expect(verifyPreimage(preimage, known)).toBe(true)
  })

  it("rejects junk without throwing", () => {
    for (const p of [undefined, "", "zz", "g".repeat(64), "ab"]) {
      expect(verifyPreimage(p, "0".repeat(64))).toBe(false)
    }
  })
})

describe("matchReceipt", () => {
  const providerSk = generateSecretKey()
  const providerPk = getPublicKey(providerSk)

  function receipt(order: Order, over: Partial<SignedEvent> = {}): SignedEvent {
    const base = {
      kind: KINDS.ZAP_RECEIPT,
      created_at: NOW_S + 30,
      content: "",
      tags: [
        ["p", MERCHANT],
        ["bolt11", REAL_PR],
        ["description", JSON.stringify(order.zapRequest)],
      ],
    }
    return { ...finalizeEvent(base, providerSk), ...over } as SignedEvent
  }

  const order = () =>
    makeOrder({
      invoices: [invoice(21_000)],
      payee: { ...makeOrder().payee, nostrPubkey: providerPk },
    })

  it("accepts the genuine receipt", () => {
    const o = order()
    const r = matchReceipt(receipt(o), o)
    expect(r).toMatchObject({ ok: true, paymentHash: REAL_HASH })
  })

  it("rejects a receipt signed by anyone but the pinned provider key", () => {
    const o = order()
    const forged = finalizeEvent(
      {
        kind: KINDS.ZAP_RECEIPT,
        created_at: NOW_S + 30,
        content: "",
        tags: [
          ["p", MERCHANT],
          ["bolt11", REAL_PR],
          ["description", JSON.stringify(o.zapRequest)],
        ],
      },
      generateSecretKey()
    ) as SignedEvent
    expect(matchReceipt(forged, o)).toMatchObject({ ok: false })
  })

  it("rejects a receipt for somebody else's order", () => {
    const mine = order()
    const theirs = makeOrder({ lines: lines(4) })
    const r = matchReceipt(receipt(theirs), mine)
    expect(r).toEqual({ ok: false, reason: "different order" })
  })

  it("rejects a payment hash we never issued", () => {
    const o = order()
    expect(matchReceipt(receipt(o), { ...o, invoices: [] })).toEqual({
      ok: false,
      reason: "payment hash is not one of ours",
    })
  })

  it("rejects a tampered description whose signature no longer verifies", () => {
    const o = order()
    const tampered = { ...o.zapRequest, content: "cambiado" }
    const r = matchReceipt(
      receipt(o, {
        tags: [
          ["p", MERCHANT],
          ["bolt11", REAL_PR],
          ["description", JSON.stringify(tampered)],
        ],
      }),
      o
    )
    expect(r).toMatchObject({ ok: false })
  })

  it("still accepts a receipt whose preimage is garbage", () => {
    // Plenty of providers ship an empty or bogus preimage; that must not
    // invalidate an otherwise sound receipt.
    const o = order()
    const signed = finalizeEvent(
      {
        kind: KINDS.ZAP_RECEIPT,
        created_at: NOW_S + 30,
        content: "",
        tags: [
          ["p", MERCHANT],
          ["bolt11", REAL_PR],
          ["description", JSON.stringify(o.zapRequest)],
          ["preimage", "nope"],
        ],
      },
      providerSk
    ) as SignedEvent
    expect(matchReceipt(signed, o)).toMatchObject({
      ok: true,
      preimageVerified: false,
    })
  })

  it("rejects a receipt whose own signature does not verify", () => {
    // A relay is not a validator. Without this check `e.pubkey` is just a
    // claim, and the pinned-key check below it would verify nothing.
    const o = order()
    const good = receipt(o)
    const mutated: SignedEvent = {
      ...good,
      tags: [...good.tags, ["preimage", "00".repeat(32)]],
    }
    expect(matchReceipt(mutated, o)).toEqual({
      ok: false,
      reason: "receipt signature invalid",
    })
  })

  it("refuses to match at all when the payee advertises no nostr key", () => {
    const o = order()
    const r = matchReceipt(receipt(o), {
      ...o,
      payee: { ...o.payee, nostrPubkey: null },
    })
    expect(r).toEqual({ ok: false, reason: "payee advertises no nostr key" })
  })
})

describe("parseOrder", () => {
  it("round-trips an order it wrote", () => {
    const o = makeOrder()
    expect(parseOrder(JSON.stringify(o), NOW_MS)?.id).toBe(o.id)
  })

  it("rejects a tampered zap request — storage is untrusted input", () => {
    const o = makeOrder()
    const tampered = { ...o, zapRequest: { ...o.zapRequest, content: "otro" } }
    expect(parseOrder(JSON.stringify(tampered), NOW_MS)).toBeNull()
  })

  it("rejects an order whose id does not match its event", () => {
    const o = makeOrder()
    expect(parseOrder(JSON.stringify({ ...o, id: "9".repeat(64) }), NOW_MS)).toBeNull()
  })

  it("rejects lines that no longer hash to the committed basket", () => {
    const o = makeOrder()
    const swapped = { ...o, lines: [{ ...o.lines[0]!, qty: 99 }, o.lines[1]!] }
    expect(parseOrder(JSON.stringify(swapped), NOW_MS)).toBeNull()
  })

  it("drops an order older than a day", () => {
    const o = makeOrder()
    expect(parseOrder(JSON.stringify(o), NOW_MS + 25 * 3_600_000)).toBeNull()
  })

  it("returns null for junk", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2}']) {
      expect(parseOrder(raw, NOW_MS)).toBeNull()
    }
  })
})

describe("classifyNostrParam", () => {
  const zapJson = JSON.stringify({ kind: 9734, tags: [], content: "" })
  const META = "ec6eecbbae135c06ace1b264972667cff571de103c369268795debd7737551ee"

  it("says not-sent when we never sent one", () => {
    expect(classifyNostrParam("abc", null, META)).toBe("not-sent")
  })

  it("says ignored ONLY when the invoice commits to the LNURL metadata", () => {
    // The one case that switches the receipt watcher off.
    expect(classifyNostrParam(META, zapJson, META)).toBe("ignored")
  })

  it("says honored on an exact byte match", () => {
    const exact = bytesToHex(sha256(utf8ToBytes(zapJson)))
    expect(classifyNostrParam(exact, zapJson, META)).toBe("honored")
  })

  it("says unknown when the server re-serialised the JSON", () => {
    // OBSERVED LIVE against primal.net: it honours the zap request but hashes
    // its own re-stringified copy, so the hash matches neither ours nor the
    // metadata. Calling that "ignored" would disable the ONLY automatic
    // payment detection that wallet supports — it has no LUD-21 endpoint.
    const primalDescriptionHash =
      "a694c834f55cf7183b488b99556662293e772a3b75548e35dc0a445ea95e4b7a"
    expect(classifyNostrParam(primalDescriptionHash, zapJson, META)).toBe("unknown")
  })

  it("says unknown when the invoice carries no description hash at all", () => {
    expect(classifyNostrParam(null, zapJson, META)).toBe("unknown")
  })
})

describe("reconcilePayee", () => {
  const pinned = () =>
    makeOrder({
      payee: {
        ...makeOrder().payee,
        callbackOrigin: "https://coinos.io",
        nostrPubkey: "b".repeat(64),
      },
    })

  const fresh = (over = {}) => ({
    origin: "https://coinos.io",
    nostrPubkey: "b".repeat(64),
    allowsNostr: true,
    ...over,
  })

  it("passes when the wallet is unchanged", () => {
    expect(reconcilePayee(pinned(), fresh())).toBeNull()
  })

  it("REFUSES when the money would go to a different host", () => {
    // The whole point: a kind-0 edited mid-checkout must never silently
    // redirect a payment the customer already agreed to.
    expect(reconcilePayee(pinned(), fresh({ origin: "https://evil.example" }))).toEqual({
      kind: "payee-changed",
      was: "https://coinos.io",
      now: "https://evil.example",
    })
  })

  it("refuses when the receipt-signing key changed", () => {
    const r = reconcilePayee(pinned(), fresh({ nostrPubkey: "c".repeat(64) }))
    expect(r).toMatchObject({ kind: "payee-changed" })
  })

  it("tolerates a wallet that simply stopped advertising nostr", () => {
    // Losing zap support is a downgrade in detection, not a redirection of
    // funds — the money still goes to the same host.
    expect(reconcilePayee(pinned(), fresh({ allowsNostr: false }))).toBeNull()
  })

  it("does not trip on an order pinned before origins were recorded", () => {
    const legacy = makeOrder({
      payee: { ...makeOrder().payee, callbackOrigin: "", nostrPubkey: null },
    })
    expect(reconcilePayee(legacy, fresh())).toBeNull()
  })
})
