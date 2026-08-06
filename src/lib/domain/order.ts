import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"

import { decodeInvoice } from "@/lib/domain/bolt11"
import type { CartLine } from "@/lib/domain/cart"
import type { AppliedCoupon, DiscountEntry } from "@/lib/domain/coupon"
import { KINDS } from "@/lib/domain/kinds"
import { formatAmount } from "@/lib/domain/price"
import { nowSeconds } from "@/lib/nostr/created-at"
import { tagValue } from "@/lib/nostr/tags"
import { verifySignedEvent } from "@/lib/nostr/verify"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * An order IS a NIP-57 zap request.
 *
 * We sign a kind-9734 with a throwaway key; its `id` — sha256 over the
 * serialised event — is the order number. That single choice buys, with no
 * backend at all: an identifier nobody else could have produced, the line
 * items travelling inside the event to the merchant's wallet, and a
 * provider-signed kind-9735 receipt as proof of payment.
 *
 * Three consequences that shape everything below:
 *
 *  D1. The 9734 carries NO `amount` tag. NIP-57 Appendix A only enforces
 *      amount agreement when the tag is present, so omitting it is the one
 *      thing that lets us re-invoice at a fresh exchange rate while keeping
 *      the SAME order id. With the tag, every re-quote would force a re-sign,
 *      and a re-sign is a new id.
 *  D2. The ephemeral key is destroyed after signing. Nothing downstream needs
 *      it — re-invoicing resubmits the already-signed event byte for byte —
 *      and persisting it would turn an "ephemeral" key into a durable
 *      pseudonym linking a shopper's purchases across unrelated storefronts.
 *  D3. The order id can never appear inside the 9734: the id is a hash of the
 *      event, so any tag holding it would be circular. That is precisely why
 *      the id has to ride in the LUD-12 comment instead.
 */

export type OrderStatus =
  | "awaiting_invoice"
  | "invoice_failed"
  | "awaiting_payment"
  /**
   * Nothing to pay: a coupon took the total to zero and the customer reclaimed
   * the order instead of paying it. Distinct from `paid` because there is no
   * invoice and no proof — `settle()` cannot produce this one, and the record
   * that it happened lives in the coupon claim, not in a zap receipt.
   */
  | "claimed"
  | "expired"
  | "paid"
  | "manually_confirmed"
  | "cancelled"

const TERMINAL: ReadonlySet<OrderStatus> = new Set(["paid", "claimed", "cancelled"])
export const isTerminal = (s: OrderStatus) => TERMINAL.has(s)

export interface OrderLine {
  d: string
  qty: number
  title: string
  unitAmount: number
  currency: string
}

/** Everything about the payee, frozen at checkout. See §payee-changed. */
export interface PayeePin {
  merchantPubkey: string
  lud16: string
  /** Opaque signed token for our own proxy — never a raw URL. */
  callbackToken: string
  callbackOrigin: string
  /** null ⇒ allowsNostr is false ⇒ no receipt will ever arrive. */
  nostrPubkey: string | null
  /** sha256 of the LNURL `metadata` string, for the honoured/ignored test. */
  metadataSha256: string
  commentAllowed: number
  minSendable: number
  maxSendable: number
}

export interface QuoteSnapshot {
  totalMsat: number
  perCurrency: { currency: string; subtotal: number; sats: number }[]
  rateAsOf: number
  quotedAt: number
}

export type InvoiceState = "live" | "superseded" | "expired" | "settled"

/** Did the provider honour our `nostr` param, or silently fall back? */
export type NostrParamStatus = "honored" | "ignored" | "unknown" | "not-sent"

/**
 * Decide whether a zap receipt is ever going to arrive.
 *
 * LUD-06 puts `sha256(metadata)` in the invoice's description hash for a
 * plain pay; NIP-57 puts `sha256(zapRequestJson)` there for a zap. So the
 * invoice itself tells us which one the server actually did.
 *
 * The third outcome is the common one and the reason this is not a boolean:
 * servers routinely `JSON.parse` then re-`stringify` the zap request before
 * hashing, which changes the bytes and therefore the hash while honouring the
 * request perfectly. primal.net does exactly this. Treating that as "ignored"
 * would switch off the receipt watcher on a wallet that does send receipts —
 * and for a merchant whose wallet has no LUD-21 endpoint, that is the only
 * automatic detection there is.
 */
export function classifyNostrParam(
  descriptionHash: string | null,
  zapRequestJson: string | null,
  metadataSha256: string
): NostrParamStatus {
  if (!zapRequestJson) return "not-sent"
  if (!descriptionHash) return "unknown"
  if (descriptionHash === bytesToHex(sha256(utf8ToBytes(zapRequestJson)))) {
    return "honored"
  }
  if (descriptionHash === metadataSha256) return "ignored"
  return "unknown"
}

export interface Invoice {
  pr: string
  paymentHash: string
  /** What we asked for. */
  amountMsat: number
  /** What the BOLT-11 actually says. A mismatch is a rejection. */
  bolt11AmountMsat: number | null
  /** Wall-clock ms, anchored at FETCH time — never at the provider's clock. */
  hardExpiresAt: number
  /** min(hardExpiresAt, issuedAt + QUOTE_TTL). A UI state, not a teardown. */
  displayExpiresAt: number
  issuedAt: number
  verifyToken: string | null
  nostrParamStatus: NostrParamStatus
  state: InvoiceState
  quote: QuoteSnapshot
}

export type ProofKind = "preimage-verified" | "receipt" | "lud21" | "manual"

export interface Proof {
  kind: ProofKind
  at: number
  paymentHash: string | null
  preimage?: string
  receiptEventId?: string
  source?: string
}

export type OrderAnomaly =
  | { kind: "receipt-missing"; since: number }
  | { kind: "lud21-silent"; since: number }
  | { kind: "underpaid"; expectedMsat: number; paidMsat: number }
  | { kind: "double-paid"; paymentHashes: string[] }
  | { kind: "payee-changed"; was: string; now: string }
  | { kind: "items-truncated"; fidelity: ItemFidelity }

export type ItemFidelity = 1 | 2 | 3 | 4

export interface Order {
  v: 1
  /** The kind-9734 event id. THE order number. */
  id: string
  status: OrderStatus
  /** Unix SECONDS — equals zapRequest.created_at. */
  createdAt: number
  updatedAt: number
  payee: PayeePin
  lines: OrderLine[]
  itemsHash: string
  /** The signed 9734, persisted verbatim and resubmitted verbatim. */
  zapRequest: SignedEvent
  itemsFidelity: ItemFidelity
  commentSent: "full" | "truncated" | "omitted"
  invoices: Invoice[]
  proofs: Proof[]
  anomalies: OrderAnomaly[]
  buyerNote?: string
  paidAt?: number
  /**
   * The coupon this order was placed with, if any.
   *
   * `coupon.claimedAt` being set is what stops a re-invoice from redeeming the
   * nonce twice: the first invoice consumes it, every later quote for the same
   * order reuses that redemption. Additive, so ORDER_VERSION does not move.
   */
  coupon?: AppliedCoupon
}

export const ORDER_VERSION = 1 as const
export const orderKey = (merchantPubkey: string) => `mm:order:${merchantPubkey}`

/** How long a sat quote is presented as current. Does not void the invoice. */
export const QUOTE_TTL_MS = 10 * 60_000
/** Keep watching a dead invoice this long past its real expiry. */
export const WATCH_GRACE_MS = 120_000

// ───────────────────────────────────────────────────────────────────────────
// Item commitment
// ───────────────────────────────────────────────────────────────────────────

/**
 * A hash over the exact basket, order-independent.
 *
 * This is what makes the size ladder below safe: even at maximum degradation,
 * where no per-line tag survives, the signed event still commits to precisely
 * what was ordered. Amounts go through formatAmount() so the serialisation
 * matches what the product's own NIP-99 `price` tag carries.
 */
export function canonicalItemsHash(lines: readonly OrderLine[]): string {
  const canon = JSON.stringify(
    [...lines]
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
      .map((l) => [
        l.d,
        l.qty,
        formatAmount({ amount: l.unitAmount, currency: l.currency }),
        l.currency,
      ])
  )
  return bytesToHex(sha256(utf8ToBytes(canon)))
}

export function toOrderLines(lines: readonly CartLine[]): OrderLine[] {
  return lines.map((l) => ({
    d: l.d,
    qty: l.qty,
    title: l.title,
    unitAmount: l.unitAmount,
    currency: l.currency,
  }))
}

// ───────────────────────────────────────────────────────────────────────────
// Zap request construction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Budget for the whole outbound callback URL.
 *
 * The real ceiling is the server's request-line limit: nginx
 * (`large_client_header_buffers`) and Apache (`LimitRequestLine`) both default
 * to 8190. The 2048 figure everyone quotes was IE's address bar, which has
 * nothing to do with a fetch. 3000 leaves 2.7x headroom and still fits ~19
 * fully-detailed line items, which covers essentially every real cart.
 */
export const URL_BUDGET = 3000

/** Max relays we ask the provider to publish the receipt to. */
const MAX_RELAY_HINTS = 4

const MAX_CONTENT = 280

export interface BuildOrderInput {
  merchantPubkey: string
  lines: readonly OrderLine[]
  /** Where the receipt should be published. Already deduped and filtered. */
  relays: readonly string[]
  callbackUrlForSizing: string
  amountMsat: number
  comment: string | null
  buyerNote?: string
  createdAt: number
  /** Applied coupon and what it took off, per currency. */
  coupon?: { applied: AppliedCoupon; discount: readonly DiscountEntry[] }
}

type ItemTagger = ((l: OrderLine) => string[]) | null

/**
 * The degradation ladder, richest first.
 *
 * Note this uses a bespoke `item` tag rather than one `a` tag per product.
 * Providers copy every `e`/`p`/`a` tag from the request into the published
 * receipt, so a six-item cart encoded as six `a` tags would emit a 9735 that
 * Amethyst, Damus and Primal all render as six separate full-amount zaps on
 * six different listings — a 6x overstatement of the merchant's zap volume,
 * broadcast to the whole network. An `a` tag also cannot carry a quantity.
 */
const LADDER: { fidelity: ItemFidelity; tag: ItemTagger }[] = [
  {
    fidelity: 1,
    tag: (l) => [
      "item",
      l.d,
      String(l.qty),
      formatAmount({ amount: l.unitAmount, currency: l.currency }),
      l.currency,
    ],
  },
  { fidelity: 2, tag: (l) => ["item", l.d, String(l.qty)] },
  { fidelity: 3, tag: (l) => ["item", l.d.replace(/-/g, "").slice(0, 16), String(l.qty)] },
  { fidelity: 4, tag: null },
]

function totalsByCurrency(lines: readonly OrderLine[]): [string, number][] {
  const map = new Map<string, number>()
  for (const l of lines) {
    map.set(l.currency, (map.get(l.currency) ?? 0) + l.unitAmount * l.qty)
  }
  return [...map.entries()]
}

function summaryContent(lines: readonly OrderLine[], note?: string): string {
  const count = lines.reduce((n, l) => n + l.qty, 0)
  const totals = totalsByCurrency(lines)
    .map(([currency, amount]) => `${currency} ${formatAmount({ amount, currency })}`)
    .join(" + ")
  const parts = [`Pedido · ${count} ${count === 1 ? "ítem" : "ítems"}`, totals, note]
  const text = parts.filter(Boolean).join(" · ")
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text
}

export function buildZapRequestTemplate(
  input: BuildOrderInput,
  itemTag: ItemTagger,
  itemsHash: string
): EventTemplate {
  const distinct = new Set(input.lines.map((l) => l.d))
  const tags: string[][] = [
    ["p", input.merchantPubkey],
    ["relays", ...input.relays.slice(0, MAX_RELAY_HINTS)],
    ["client", "merchant-manager"],
    ["order", "1"],
    ["items_hash", itemsHash],
    ["items_count", String(input.lines.reduce((n, l) => n + l.qty, 0))],
  ]

  // GROSS totals, before any discount. The merchant's order book then reads as
  // "these items, less this coupon, equals what the invoice charged" — which is
  // what a receipt says, and it means the item tags keep matching the catalog
  // prices rather than carrying a silently marked-down number.
  for (const [currency, amount] of totalsByCurrency(input.lines)) {
    tags.push(["total", formatAmount({ amount, currency }), currency])
  }

  // Order-level and tiny, so these ride along at EVERY rung of the size ladder
  // below: a discount the merchant cannot see is worse than an item they have
  // to look up.
  if (input.coupon) {
    tags.push([
      "coupon",
      input.coupon.applied.couponId,
      input.coupon.applied.benefit.type,
      input.coupon.applied.name,
    ])
    for (const d of input.coupon.discount) {
      tags.push(["discount", formatAmount({ amount: d.amount, currency: d.currency }), d.currency])
    }
  }

  if (itemTag) for (const l of input.lines) tags.push(itemTag(l))

  // A single-product cart genuinely IS a zap on that listing: the `a` tag is
  // semantically right, renders correctly everywhere, and lets the receipt be
  // filtered server-side. Only that case earns it.
  if (distinct.size === 1) {
    const only = input.lines[0]!
    tags.push(["a", `${KINDS.PRODUCT}:${input.merchantPubkey}:${only.d}`])
    tags.push(["k", String(KINDS.PRODUCT)])
  }

  return {
    kind: KINDS.ZAP_REQUEST,
    created_at: input.createdAt,
    content: summaryContent(input.lines, input.buyerNote),
    tags,
  }
}

/**
 * Build the callback URL by hand rather than via URLSearchParams.
 *
 * `URLSearchParams` serialises spaces as `+`, which is correct for
 * form-encoding but is decoded literally by more than one LNURL server.
 * `encodeURIComponent` emits `%20`, which everything understands.
 */
export function buildCallbackUrl(
  callback: string,
  amountMsat: number,
  zapRequest: SignedEvent | null,
  comment: string | null
): string {
  const parts = [`amount=${amountMsat}`]
  if (zapRequest) {
    parts.push(`nostr=${encodeURIComponent(JSON.stringify(zapRequest))}`)
  }
  if (comment) parts.push(`comment=${encodeURIComponent(comment)}`)
  return `${callback}${callback.includes("?") ? "&" : "?"}${parts.join("&")}`
}

/** id/pubkey/sig are fixed-length hex, and hex never escapes — so a
 *  placeholder measures byte-identically to the real thing, with no crypto. */
const HEX64 = "0".repeat(64)
const HEX128 = "0".repeat(128)

function probeLength(input: BuildOrderInput, template: EventTemplate): number {
  const probe: SignedEvent = { ...template, id: HEX64, pubkey: HEX64, sig: HEX128 }
  return buildCallbackUrl(
    input.callbackUrlForSizing,
    input.amountMsat,
    probe,
    input.comment
  ).length
}

export interface FittedZapRequest {
  template: EventTemplate
  fidelity: ItemFidelity
  itemsHash: string
}

/**
 * Pick the richest item encoding that still fits in URL_BUDGET.
 *
 * Measures the FINAL URL, not the JSON: encodeURIComponent expands unevenly
 * (hex barely grows, punctuation triples), so a JSON-side budget is wrong by
 * up to 20% — in the direction that breaks.
 */
export function fitZapRequest(input: BuildOrderInput): FittedZapRequest {
  const itemsHash = canonicalItemsHash(input.lines)
  let last = buildZapRequestTemplate(input, LADDER[0]!.tag, itemsHash)

  for (const rung of LADDER) {
    const template = buildZapRequestTemplate(input, rung.tag, itemsHash)
    last = template
    if (probeLength(input, template) <= URL_BUDGET) {
      return { template, fidelity: rung.fidelity, itemsHash }
    }
  }

  // Rung 4 has no per-line tags at all, so its size is bounded by the relay
  // list and the content string. Returning it is strictly better than
  // throwing: items_hash still commits to the basket.
  return { template: last, fidelity: 4, itemsHash }
}

/**
 * Sign the zap request with a key that lives for one millisecond.
 *
 * The secret is zeroed and never returned — see D2. Callers get the signed
 * event, whose id is the order number.
 */
export function signZapRequest(template: EventTemplate): SignedEvent {
  const sk = generateSecretKey()
  try {
    return finalizeEvent(template, sk) as SignedEvent
  } finally {
    sk.fill(0)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// LUD-12 comment
// ───────────────────────────────────────────────────────────────────────────

/**
 * What to put in the LUD-12 comment — the ONLY channel that can carry the
 * order id (D3), and the merchant's only reference inside their own wallet.
 *
 * `omitted` means send NO comment parameter at all. Sending one when the
 * server declared `commentAllowed: 0` violates LUD-12 and makes some servers
 * reject the whole callback.
 */
export function planComment(
  commentAllowed: number,
  orderId: string
): { comment: string | null; sent: Order["commentSent"] } {
  if (!Number.isFinite(commentAllowed) || commentAllowed <= 0) {
    return { comment: null, sent: "omitted" }
  }
  const full = `Pedido ${orderId}`
  if (commentAllowed >= full.length) return { comment: full, sent: "full" }
  if (commentAllowed >= orderId.length) return { comment: orderId, sent: "full" }
  // 16 hex chars is 64 bits — unique across any real merchant's order book.
  if (commentAllowed >= 16) {
    return { comment: orderId.slice(0, commentAllowed), sent: "truncated" }
  }
  return { comment: null, sent: "omitted" }
}

// ───────────────────────────────────────────────────────────────────────────
// Settlement
// ───────────────────────────────────────────────────────────────────────────

/**
 * Proof strength. Higher wins when two detectors disagree.
 *
 * A preimage is unforgeable arithmetic. A receipt is signed by the provider's
 * own key. LUD-21 is an endpoint we might merely be failing to reach. A human
 * saying "I paid" is the weakest thing we accept, and it never blocks a real
 * proof from arriving later and upgrading it.
 */
export const PROOF_RANK: Record<ProofKind, number> = {
  "preimage-verified": 4,
  receipt: 3,
  lud21: 2,
  manual: 1,
}

/**
 * Has the payee changed since this order was created?
 *
 * The `p` tag pins the merchant's NOSTR identity, but not where the money
 * lands. A re-resolve happens on every token refresh, and between the first
 * invoice and the second the merchant's kind-0 could have been edited — or
 * compromised — to point at somebody else's wallet.
 *
 * Silently re-pointing a payment the customer already agreed to is the one
 * thing that must never happen automatically, so a drift here is a hard stop
 * and a new order, not a retry.
 */
export function reconcilePayee(
  order: Order,
  fresh: { origin: string; nostrPubkey: string | null; allowsNostr: boolean }
): OrderAnomaly | null {
  const wasOrigin = order.payee.callbackOrigin
  if (wasOrigin && fresh.origin && wasOrigin !== fresh.origin) {
    return { kind: "payee-changed", was: wasOrigin, now: fresh.origin }
  }

  const freshKey = fresh.allowsNostr ? fresh.nostrPubkey : null
  if (order.payee.nostrPubkey && freshKey && order.payee.nostrPubkey !== freshKey) {
    return {
      kind: "payee-changed",
      was: order.payee.nostrPubkey,
      now: freshKey,
    }
  }

  return null
}

/** The asking price right now: the newest invoice we issued. */
function currentAskMsat(order: Order): number {
  return order.invoices.at(-1)?.amountMsat ?? 0
}

/**
 * The ONE mutation that can reach `paid`. Both detectors call it.
 *
 * Because this is a synchronous reducer, "who wins the race" is not a
 * question: whichever proof is dispatched first transitions the order, and
 * every later one is merged into `proofs` for the record. `paid` never
 * regresses.
 */
export function settle(order: Order, proof: Proof, now: number): Order {
  const proofs = [...order.proofs, proof]
  const anomalies = [...order.anomalies]

  if (order.status === "paid") {
    const first = order.proofs.find((p) => p.paymentHash)?.paymentHash
    if (proof.paymentHash && first && proof.paymentHash !== first) {
      const already = anomalies.some((a) => a.kind === "double-paid")
      if (!already) {
        anomalies.push({
          kind: "double-paid",
          paymentHashes: [first, proof.paymentHash],
        })
      }
    }
    return { ...order, proofs, anomalies, updatedAt: now }
  }

  if (order.status === "cancelled") return order

  if (PROOF_RANK[proof.kind] <= PROOF_RANK.manual) {
    return { ...order, status: "manually_confirmed", proofs, updatedAt: now }
  }

  const settledInvoice = order.invoices.find(
    (i) => i.paymentHash === proof.paymentHash
  )
  const ask = currentAskMsat(order)
  if (settledInvoice && ask > settledInvoice.amountMsat) {
    // They paid a stale, cheaper invoice. Still paid — but the merchant is
    // owed the difference and must be told, not quietly short-changed.
    anomalies.push({
      kind: "underpaid",
      expectedMsat: ask,
      paidMsat: settledInvoice.amountMsat,
    })
  }

  return {
    ...order,
    status: "paid",
    paidAt: now,
    proofs,
    anomalies,
    invoices: order.invoices.map((i) =>
      i.paymentHash === proof.paymentHash ? { ...i, state: "settled" } : i
    ),
    updatedAt: now,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Receipt matching
// ───────────────────────────────────────────────────────────────────────────

export type ReceiptMatch =
  | { ok: false; reason: string }
  | { ok: true; paymentHash: string; preimageVerified: boolean; preimage?: string }

const no = (reason: string): ReceiptMatch => ({ ok: false, reason })

/**
 * Re-exported so the receipt matcher below reads in one place, and so existing
 * importers keep working. It lives in src/lib/nostr/verify.ts because NIP-98
 * request authentication needs the same guarantee and must not import the
 * entire order module to get it.
 */
export { verifySignedEvent }

/**
 * Is this kind-9735 the receipt for THIS order?
 *
 * Check 2 alone eliminates false positives: `order.id` is the sha256 of an
 * event signed by a key that existed for a millisecond in one browser, so a
 * concurrent unrelated zap — same merchant, same second, same amount — cannot
 * collide with it. This is hash equality, not a heuristic. Checks 1, 3 and 4
 * are defence against a hostile relay and a buggy provider.
 */
export function matchReceipt(e: SignedEvent, order: Order): ReceiptMatch {
  if (e.kind !== KINDS.ZAP_RECEIPT) return no("wrong kind")

  // 0. The receipt's OWN signature. Without this, `e.pubkey` is merely a
  //    claim and check 1 below verifies nothing: a hostile relay could hand
  //    us an unsigned event carrying the provider's pubkey and a legitimate
  //    `description` copied from a real zap. Never trust a relay to have
  //    validated anything.
  if (!verifySignedEvent(e)) return no("receipt signature invalid")

  // 1. AUTHORSHIP — pinned at checkout, so a later kind-0 edit cannot
  //    retarget us at an attacker's key.
  if (!order.payee.nostrPubkey) return no("payee advertises no nostr key")
  if (e.pubkey !== order.payee.nostrPubkey) return no("not from the pinned nostrPubkey")
  if (tagValue(e, "p") !== order.payee.merchantPubkey) return no("wrong recipient")

  // 2. IDENTITY.
  const descRaw = tagValue(e, "description")
  if (!descRaw) return no("no description tag")
  let desc: SignedEvent
  try {
    desc = JSON.parse(descRaw) as SignedEvent
  } catch {
    return no("description is not JSON")
  }
  if (desc?.id !== order.id) return no("different order")
  if (!verifySignedEvent(desc)) return no("description signature invalid")

  // 3. INVOICE BINDING — ties the receipt to an invoice we actually issued.
  const bolt11 = tagValue(e, "bolt11")
  if (!bolt11) return no("no bolt11 tag")
  const decoded = decodeInvoice(bolt11)
  if (!decoded?.paymentHash) return no("undecodable bolt11")
  if (!order.invoices.some((i) => i.paymentHash === decoded.paymentHash)) {
    return no("payment hash is not one of ours")
  }

  // 4. CRYPTOGRAPHIC PROOF — optional; plenty of providers ship an empty or
  //    garbage preimage, which must not invalidate an otherwise good receipt.
  const preimage = tagValue(e, "preimage")
  const preimageVerified = verifyPreimage(preimage, decoded.paymentHash)

  return {
    ok: true,
    paymentHash: decoded.paymentHash,
    preimageVerified,
    preimage: preimageVerified ? preimage : undefined,
  }
}

/**
 * sha256(preimage) === payment_hash.
 *
 * Unforgeable, needs no server, and keeps working when the provider, the
 * relays and our own API are all down — which is why the UI offers a
 * "paste your preimage" escape hatch.
 */
export function verifyPreimage(
  preimage: string | undefined,
  paymentHash: string
): boolean {
  if (!preimage || !/^[0-9a-f]{64}$/i.test(preimage.trim())) return false
  try {
    return bytesToHex(sha256(hexToBytes(preimage.trim().toLowerCase()))) === paymentHash
  } catch {
    return false
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────────────

/** Orders older than this are dropped on load rather than resumed. */
export const ORDER_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * Rebuild an order from localStorage, verifying it end to end.
 *
 * The stored blob is untrusted input: re-deriving the event hash and checking
 * the signature costs about a millisecond and means tampered storage can
 * never make us watch — or claim payment on — somebody else's order.
 */
export function parseOrder(raw: string | null, now: number): Order | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Order>
    if (parsed.v !== ORDER_VERSION) return null
    if (typeof parsed.id !== "string" || !parsed.zapRequest) return null
    if (typeof parsed.createdAt !== "number") return null
    if (now - parsed.createdAt * 1000 > ORDER_MAX_AGE_MS) return null

    const zr = parsed.zapRequest
    if (zr.id !== parsed.id) return null
    if (!verifySignedEvent(zr)) return null

    const order = parsed as Order
    if (!Array.isArray(order.invoices) || !Array.isArray(order.proofs)) return null
    if (!Array.isArray(order.lines) || !Array.isArray(order.anomalies)) return null
    if (order.itemsHash !== canonicalItemsHash(order.lines)) return null
    return order
  } catch {
    return null
  }
}

export function newOrderCreatedAt(): number {
  // Kind 9734 is a REGULAR event: nextCreatedAt() is for replaceables and
  // maintains a per-address high-water mark that means nothing here.
  return nowSeconds()
}
