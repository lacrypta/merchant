import { decodeInvoice } from "@/lib/domain/bolt11"
import { KINDS } from "@/lib/domain/kinds"
import { firstTag, tagValue } from "@/lib/nostr/tags"
import { toSats, type SatPriceTable } from "@/lib/domain/rates"
import type { SignedEvent } from "@/lib/nostr/types"

/** A line item committed to by the buyer's signed kind-9734 request. */
export interface ZapOrderLine {
  d: string
  qty: number
  unitAmount?: number
  currency?: string
}

export interface ZapOrderTotal {
  amount: number
  currency: string
}

/** The coupon the buyer applied, as named by the request's `coupon` tag. */
export interface ZapOrderCoupon {
  id: string
  type: string
  name: string
}

/**
 * A payment receipt paired with the request embedded in its `description`
 * tag. The receipt is kept even when its request is missing or malformed: a
 * merchant must never lose sight of a payment just because a provider emitted
 * an incomplete event.
 */
export interface ZapReceiptOrder {
  receipt: SignedEvent
  zapRequest: SignedEvent | null
  lines: ZapOrderLine[]
  itemsCount: number | null
  /** GROSS, before any discount — see buildZapRequestTemplate. */
  totals: ZapOrderTotal[]
  /** Null when no coupon was used, which is the common case. */
  coupon: ZapOrderCoupon | null
  /**
   * What the coupon took off, per currency. `totals` minus this is what the
   * invoice actually charged.
   */
  discounts: ZapOrderTotal[]
  /** Exact amount carried by the receipt's BOLT-11 invoice. */
  receiptSats: number | null
}

export type SatAllocationQuality = "exact" | "estimated" | "unavailable"

export interface AllocatedZapOrderLine extends ZapOrderLine {
  /** Aggregate sats for this line (quantity included). */
  sats: number | null
}

function isSignedEvent(value: unknown): value is SignedEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<SignedEvent>
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.kind === "number" &&
    typeof event.created_at === "number" &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === "string"))
  )
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined
}

function receiptSats(receipt: SignedEvent): number | null {
  const bolt11 = tagValue(receipt, "bolt11")
  if (!bolt11) return null
  const amountMsat = decodeInvoice(bolt11)?.amountMsat
  return amountMsat === null || amountMsat === undefined ? null : amountMsat / 1000
}

/** Read the signed zap request carried inside a NIP-57 receipt. */
export function zapRequestFromReceipt(receipt: SignedEvent): SignedEvent | null {
  const raw = tagValue(receipt, "description")
  if (!raw) return null
  try {
    const request: unknown = JSON.parse(raw)
    return isSignedEvent(request) && request.kind === KINDS.ZAP_REQUEST ? request : null
  } catch {
    return null
  }
}

/**
 * Project a kind-9735 into the order view.
 *
 * The merchant match is deliberately checked twice: first on the receipt and
 * again on the embedded request. A relay cannot make an unrelated zap look
 * like a sale by replacing only one half of the pair.
 */
export function parseZapReceiptOrder(
  receipt: SignedEvent,
  merchantPubkey: string
): ZapReceiptOrder | null {
  if (receipt.kind !== KINDS.ZAP_RECEIPT || tagValue(receipt, "p") !== merchantPubkey) {
    return null
  }

  const candidate = zapRequestFromReceipt(receipt)
  const zapRequest = candidate && tagValue(candidate, "p") === merchantPubkey ? candidate : null
  const lines = (zapRequest?.tags ?? []).flatMap((tag): ZapOrderLine[] => {
    if (tag[0] !== "item" || !tag[1]) return []
    const qty = parsePositiveInteger(tag[2])
    if (!qty) return []
    return [
      {
        d: tag[1],
        qty,
        unitAmount: parseAmount(tag[3]),
        currency: tag[4]?.trim().toUpperCase() || undefined,
      },
    ]
  })
  const amountTags = (name: string): ZapOrderTotal[] =>
    (zapRequest?.tags ?? []).flatMap((tag): ZapOrderTotal[] => {
      if (tag[0] !== name || !tag[2]) return []
      const amount = parseAmount(tag[1])
      if (amount === undefined) return []
      return [{ amount, currency: tag[2].trim().toUpperCase() }]
    })

  const couponTag = zapRequest ? firstTag(zapRequest, "coupon") : undefined

  return {
    receipt,
    zapRequest,
    lines,
    itemsCount: zapRequest ? parsePositiveInteger(firstTag(zapRequest, "items_count")?.[1]) : null,
    totals: amountTags("total"),
    coupon:
      couponTag?.[1] && couponTag[2]
        ? { id: couponTag[1], type: couponTag[2], name: couponTag[3] ?? "" }
        : null,
    discounts: amountTags("discount"),
    receiptSats: receiptSats(receipt),
  }
}

/**
 * Allocate the invoice total back to the request's line items.
 *
 * Same-currency allocation is exact because the exchange rate cancels from
 * every weight. Mixed-currency allocation needs a common unit, so it uses the
 * supplied sat-price table and is explicitly labeled estimated: those are
 * current rates, not the historical checkout quote.
 */
export function allocateOrderLineSats(
  order: ZapReceiptOrder,
  rates: SatPriceTable | null
): { lines: AllocatedZapOrderLine[]; quality: SatAllocationQuality } {
  const unavailable = (): {
    lines: AllocatedZapOrderLine[]
    quality: SatAllocationQuality
  } => ({
    lines: order.lines.map((line) => ({ ...line, sats: null })),
    quality: "unavailable",
  })

  if (order.receiptSats === null || order.lines.length === 0) return unavailable()

  if (order.lines.length === 1) {
    return {
      lines: [{ ...order.lines[0]!, sats: Math.round(order.receiptSats) }],
      quality: "exact",
    }
  }

  if (
    order.lines.some(
      (line) =>
        line.unitAmount === undefined ||
        !line.currency ||
        line.unitAmount < 0
    )
  ) {
    return unavailable()
  }

  const currencies = new Set(order.lines.map((line) => line.currency!))
  const sameCurrency = currencies.size === 1
  const weights = order.lines.map((line) => {
    const subtotal = line.unitAmount! * line.qty
    if (sameCurrency) return subtotal
    return rates ? toSats(subtotal, line.currency!, rates) : null
  })

  const numericWeights = weights.filter((weight): weight is number => weight !== null)
  if (
    numericWeights.length !== weights.length ||
    numericWeights.every((weight) => weight === 0)
  ) {
    return unavailable()
  }

  // Largest-remainder allocation keeps every row whole-sat and reconciles
  // exactly to the receipt total.
  const totalSats = Math.round(order.receiptSats)
  const weightTotal = numericWeights.reduce((sum, weight) => sum + weight, 0)
  const raw = numericWeights.map((weight) => (weight / weightTotal) * totalSats)
  const allocated = raw.map(Math.floor)
  let remainder = totalSats - allocated.reduce((sum, value) => sum + value, 0)
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let index = 0; index < byFraction.length && remainder > 0; index += 1) {
    allocated[byFraction[index]!.index]! += 1
    remainder -= 1
  }

  return {
    lines: order.lines.map((line, index) => ({ ...line, sats: allocated[index]! })),
    quality: sameCurrency ? "exact" : "estimated",
  }
}
