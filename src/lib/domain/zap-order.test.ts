import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { describe, expect, it } from "vitest"

import { KINDS } from "@/lib/domain/kinds"
import {
  allocateOrderLineSats,
  parseZapReceiptOrder,
  type ZapReceiptOrder,
} from "@/lib/domain/zap-order"
import type { SignedEvent } from "@/lib/nostr/types"

const MERCHANT = "a".repeat(64)

/**
 * Really signed, with a throwaway key.
 *
 * `parseZapReceiptOrder` verifies both the receipt and the request now, so a
 * hand-written `sig: "dddd…"` makes every fixture parse to null and every
 * assertion here vacuous. `id` and `sig` are whatever finalizeEvent computes;
 * overriding them on purpose is how the forgery cases below work.
 */
function event(overrides: Partial<SignedEvent>): SignedEvent {
  const rest = { ...overrides }
  delete rest.id
  delete rest.sig
  delete rest.pubkey

  const signed = finalizeEvent(
    {
      kind: KINDS.ZAP_RECEIPT,
      created_at: 1,
      content: "",
      tags: [["p", MERCHANT]],
      ...rest,
    },
    generateSecretKey()
  ) as SignedEvent
  // Only re-apply the identity fields a test deliberately tampered with.
  return {
    ...signed,
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    ...(overrides.sig !== undefined ? { sig: overrides.sig } : {}),
    ...(overrides.pubkey !== undefined ? { pubkey: overrides.pubkey } : {}),
  }
}

describe("parseZapReceiptOrder", () => {
  it("takes item quantities from the embedded zap request", () => {
    const request = event({
      kind: KINDS.ZAP_REQUEST,
      tags: [
        ["p", MERCHANT],
        ["items_count", "3"],
        ["total", "3000", "ARS"],
        ["item", "cafe", "2", "1500", "ARS"],
        ["item", "tostada", "1"],
      ],
    })
    const receipt = event({ tags: [["p", MERCHANT], ["description", JSON.stringify(request)]] })

    expect(parseZapReceiptOrder(receipt, MERCHANT)).toMatchObject({
      zapRequest: request,
      itemsCount: 3,
      totals: [{ amount: 3000, currency: "ARS" }],
      lines: [
        { d: "cafe", qty: 2, unitAmount: 1500, currency: "ARS" },
        { d: "tostada", qty: 1 },
      ],
    })
  })

  it("keeps a receipt visible when its zap request cannot be read", () => {
    const receipt = event({ tags: [["p", MERCHANT], ["description", "not json"]] })

    expect(parseZapReceiptOrder(receipt, MERCHANT)).toMatchObject({
      receipt,
      zapRequest: null,
      lines: [],
      itemsCount: null,
      totals: [],
      receiptSats: null,
    })
  })

  it("does not accept a receipt or request for another merchant", () => {
    const other = "e".repeat(64)
    expect(parseZapReceiptOrder(event({ tags: [["p", other]] }), MERCHANT)).toBeNull()

    const request = event({ kind: KINDS.ZAP_REQUEST, tags: [["p", other]] })
    const receipt = event({ tags: [["p", MERCHANT], ["description", JSON.stringify(request)]] })
    expect(parseZapReceiptOrder(receipt, MERCHANT)?.zapRequest).toBeNull()
  })

  it("refuses a receipt whose signature does not verify", () => {
    // What anyone able to write to a relay the merchant reads would publish:
    // the right tags, the right merchant, an amount of their choosing, and a
    // signature they could not produce.
    const forged = event({
      sig: "d".repeat(128),
      tags: [
        ["p", MERCHANT],
        ["bolt11", "lnbc10u1p3xyz"],
      ],
    })
    expect(parseZapReceiptOrder(forged, MERCHANT)).toBeNull()
  })

  it("refuses a receipt whose content was edited after signing", () => {
    const real = event({ tags: [["p", MERCHANT]] })
    // Same id and sig, different tags: the id no longer hashes to the content.
    expect(
      parseZapReceiptOrder({ ...real, tags: [...real.tags, ["bolt11", "lnbc99"]] }, MERCHANT)
    ).toBeNull()
  })

  it("keeps the payment but drops the items when only the request is forged", () => {
    const request = event({
      kind: KINDS.ZAP_REQUEST,
      sig: "d".repeat(128),
      tags: [
        ["p", MERCHANT],
        ["item", "cafe", "2", "1500", "ARS"],
        ["total", "3000", "ARS"],
      ],
    })
    const receipt = event({ tags: [["p", MERCHANT], ["description", JSON.stringify(request)]] })

    // The money arrived — the receipt is genuinely signed. What cannot be
    // believed is anything the unsigned request claims was bought.
    expect(parseZapReceiptOrder(receipt, MERCHANT)).toMatchObject({
      receipt,
      zapRequest: null,
      lines: [],
      totals: [],
    })
  })
})

describe("allocateOrderLineSats", () => {
  function order(
    lines: ZapReceiptOrder["lines"],
    receiptSats = 1_000
  ): ZapReceiptOrder {
    return {
      receipt: event({}),
      zapRequest: event({ kind: KINDS.ZAP_REQUEST }),
      lines,
      itemsCount: lines.reduce((sum, line) => sum + line.qty, 0),
      totals: [],
      coupon: null,
      discounts: [],
      receiptSats,
    }
  }

  it("allocates same-currency items exactly and preserves the receipt total", () => {
    const result = allocateOrderLineSats(
      order([
        { d: "cafe", qty: 2, unitAmount: 100, currency: "ARS" },
        { d: "tostada", qty: 1, unitAmount: 200, currency: "ARS" },
      ]),
      null
    )

    expect(result.quality).toBe("exact")
    expect(result.lines.map((line) => line.sats)).toEqual([500, 500])
  })

  it("labels mixed-currency allocation as estimated", () => {
    const result = allocateOrderLineSats(
      order([
        { d: "cafe", qty: 1, unitAmount: 1_000, currency: "ARS" },
        { d: "merch", qty: 1, unitAmount: 10, currency: "USD" },
      ]),
      { SAT: 1, ARS: 10, USD: 0.1 }
    )

    expect(result.quality).toBe("estimated")
    expect(result.lines.map((line) => line.sats)).toEqual([500, 500])
  })

  it("does not invent an allocation when price data is missing", () => {
    const result = allocateOrderLineSats(
      order([
        { d: "cafe", qty: 1 },
        { d: "merch", qty: 1, unitAmount: 10, currency: "USD" },
      ]),
      null
    )

    expect(result).toMatchObject({
      quality: "unavailable",
      lines: [{ sats: null }, { sats: null }],
    })
  })
})

describe("coupon projection", () => {
  const request = (tags: string[][]) =>
    event({ kind: KINDS.ZAP_REQUEST, tags: [["p", MERCHANT], ...tags] })

  // No bolt11 tag: these cases are about reading the REQUEST's tags, and
  // receiptSats being null does not affect any of them.
  const receiptFor = (tags: string[][]) =>
    event({
      tags: [
        ["p", MERCHANT],
        ["description", JSON.stringify(request(tags))],
      ],
    })

  it("reads the coupon and its per-currency discount off the request", () => {
    const parsed = parseZapReceiptOrder(
      receiptFor([
        ["total", "1000", "ARS"],
        ["coupon", "33333333-3333-4333-8333-333333333333", "percent", "Promo verano"],
        ["discount", "100", "ARS"],
      ]),
      MERCHANT
    )
    expect(parsed?.coupon).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      type: "percent",
      name: "Promo verano",
    })
    expect(parsed?.discounts).toEqual([{ amount: 100, currency: "ARS" }])
    // Totals stay gross, so the merchant can see gross − discount = charged.
    expect(parsed?.totals).toEqual([{ amount: 1000, currency: "ARS" }])
  })

  it("reports no coupon on an ordinary order", () => {
    const parsed = parseZapReceiptOrder(receiptFor([["total", "1000", "ARS"]]), MERCHANT)
    expect(parsed?.coupon).toBeNull()
    expect(parsed?.discounts).toEqual([])
  })

  it("tolerates a coupon tag without a name", () => {
    const parsed = parseZapReceiptOrder(
      receiptFor([["coupon", "an-id", "percent"]]),
      MERCHANT
    )
    expect(parsed?.coupon).toEqual({ id: "an-id", type: "percent", name: "" })
  })

  it("ignores a coupon tag missing its type", () => {
    expect(parseZapReceiptOrder(receiptFor([["coupon", "an-id"]]), MERCHANT)?.coupon).toBeNull()
  })

  it("drops a discount tag with no currency or an unparseable amount", () => {
    const parsed = parseZapReceiptOrder(
      receiptFor([
        ["discount", "100"],
        ["discount", "nope", "ARS"],
        ["discount", "50", "usd"],
      ]),
      MERCHANT
    )
    expect(parsed?.discounts).toEqual([{ amount: 50, currency: "USD" }])
  })
})
