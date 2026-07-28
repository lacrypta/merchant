import { describe, expect, it } from "vitest"

import { KINDS } from "@/lib/domain/kinds"
import {
  allocateOrderLineSats,
  parseZapReceiptOrder,
  type ZapReceiptOrder,
} from "@/lib/domain/zap-order"
import type { SignedEvent } from "@/lib/nostr/types"

const MERCHANT = "a".repeat(64)

function event(overrides: Partial<SignedEvent>): SignedEvent {
  return {
    id: "b".repeat(64),
    pubkey: "c".repeat(64),
    sig: "d".repeat(128),
    kind: KINDS.ZAP_RECEIPT,
    created_at: 1,
    content: "",
    tags: [["p", MERCHANT]],
    ...overrides,
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
