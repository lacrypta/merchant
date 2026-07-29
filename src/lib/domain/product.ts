import { KINDS } from "@/lib/domain/kinds"
import { derivePosId } from "@/lib/domain/pos-id"
import { formatAmount, parsePriceTag, type Price } from "@/lib/domain/price"
import { slugify } from "@/lib/domain/slug"
import { nextCreatedAt } from "@/lib/nostr/created-at"
import { coordinate, tagValue, toInt } from "@/lib/nostr/tags"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/** Selects the KIND (30402 published | 30403 draft). */
export type Lifecycle = "published" | "draft"
/** The NIP-99 `status` TAG. Orthogonal to lifecycle — do not conflate. */
export type NipStatus = "active" | "sold"
/** GammaMarkets `visibility`. */
export type Visibility = "hidden" | "on-sale" | "pre-order"
export type ProductKind = "simple" | "variable" | "variation"
export type ProductFormat = "digital" | "physical"

export interface ProductImage {
  url: string
  width: number
  height: number
  /** 0 = 256px thumbnail, 1 = large. */
  order: number
}

export interface Product {
  /** crypto.randomUUID(), immutable. NEVER derived from the title. */
  d: string
  /** DERIVED from d, never stored on the event. */
  posId: number
  lifecycle: Lifecycle
  status: NipStatus
  title: string
  summary?: string
  /**
   * Stock-keeping unit. The join key with external systems (WooCommerce, an
   * ERP, a label printer) — `d` cannot serve that role because it is a UUID we
   * generate and the other side already has its own reference.
   *
   * Optional: NIP-99 has no SKU, most listings on the relays have none, and a
   * merchant selling empanadas at a fair never needs one.
   */
  sku?: string
  /** Markdown -> event.content */
  description: string
  /**
   * NIP-99 says `price` SHOULD be present, not MUST — plenty of real
   * listings omit it. null means "consultar precio"; it is NOT a parse
   * failure, because rejecting these would blank a merchant's whole catalog.
   * The LaPOS projection still requires one (an unpriced item can't be rung
   * up at a till), so it filters them out there.
   */
  price: Price | null
  /** null = untracked -> no stock/quantity tags emitted at all. */
  stock: number | null
  visibility: Visibility
  type: { kind: ProductKind; format: ProductFormat }
  /** ORDERED slugs. categories[0] is primary and the only one LaPOS sees. */
  categories: string[]
  images: ProductImage[]
  /** First publish time. Preserved across every edit. */
  publishedAt: number
  updatedAt: number
  eventId: string
  pubkey: string
  /**
   * Tags we don't model (weight, dim, spec, shipping_option, location, g...).
   * Re-emitted verbatim so we never destroy another client's data.
   */
  unknownTags: string[][]
}

/** Tags this app owns. Everything else round-trips through `unknownTags`. */
const KNOWN_TAGS = new Set([
  "d",
  "title",
  "alt",
  "published_at",
  "sku",
  "price",
  "type",
  "visibility",
  "status",
  "summary",
  "stock",
  "quantity",
  "image",
  "t",
  "a",
  "client",
])

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

/** Longest SKU we accept. WooCommerce stores it in postmeta with no hard cap. */
export const MAX_SKU_LENGTH = 100

/**
 * Trim a SKU, or drop it entirely.
 *
 * Returns undefined rather than "" so an empty SKU emits NO tag: an empty
 * `["sku", ""]` on the wire would match nothing and read as a real value.
 */
export function normalizeSku(raw: string | undefined): string | undefined {
  const sku = raw?.trim()
  return sku ? sku.slice(0, MAX_SKU_LENGTH) : undefined
}

/**
 * Is this SKU already used by another product in the catalog?
 *
 * Compared case-insensitively, which is STRICTER than WooCommerce (it treats
 * `ABC` and `abc` as distinct). Being stricter is the safe direction: we may
 * refuse a SKU Woo would have accepted, but we never let a merchant create two
 * references that are indistinguishable when read aloud or off a label.
 */
export function isSkuTaken(
  sku: string,
  products: readonly Product[],
  exceptD?: string
): boolean {
  const needle = sku.trim().toLowerCase()
  if (!needle) return false
  return products.some(
    (p) => p.d !== exceptD && p.sku?.trim().toLowerCase() === needle
  )
}

function asVisibility(v: string | undefined): Visibility | undefined {
  return v === "hidden" || v === "on-sale" || v === "pre-order" ? v : undefined
}

function parseTypeTag(e: Pick<SignedEvent, "tags">) {
  const t = e.tags.find((x) => x[0] === "type")
  if (!t) return undefined
  const kind = t[1]
  const format = t[2]
  const validKind: ProductKind =
    kind === "variable" || kind === "variation" || kind === "simple"
      ? kind
      : "simple"
  const validFormat: ProductFormat = format === "physical" ? "physical" : "digital"
  return { kind: validKind, format: validFormat }
}

function altForProduct(p: Pick<Product, "title" | "price">): string {
  if (!p.price) return `Producto: ${p.title}`
  return `Producto: ${p.title} — ${formatAmount(p.price)} ${p.price.currency}`
}

/**
 * Build the kind:30402 (or 30403) event for a product.
 *
 * Two invariants the builder must enforce:
 *  - `published_at` is the FIRST publish time and survives every edit.
 *  - `created_at` strictly increases (see nextCreatedAt).
 */
/** An event minus its timestamp: everything a relay actually stores about it. */
export type EventBody = Omit<EventTemplate, "created_at">

export function buildProductEvent(
  p: Product,
  categoryDByslug: Map<string, string>,
  previousCreatedAt?: number
): EventTemplate {
  const kind = p.lifecycle === "published" ? KINDS.PRODUCT : KINDS.PRODUCT_DRAFT
  const created_at = nextCreatedAt(
    coordinate(kind, p.pubkey, p.d),
    previousCreatedAt
  )
  return {
    ...productEventBody(p, categoryDByslug, p.publishedAt || created_at),
    created_at,
  }
}

/**
 * The timestamp-free half of the product event.
 *
 * Split out because the dashboard needs to answer "does this differ from what
 * is published?" on every render, and it must answer it against exactly the
 * bytes that would go on the wire — not a hand-maintained field list that
 * drifts out of sync with the builder.
 *
 * It cannot call buildProductEvent() to find out: that goes through
 * nextCreatedAt(), which mutates a per-address high-water mark. Diffing
 * through it would ratchet created_at forward on every render until it
 * tripped the 60-second drift guard.
 */
export function productEventBody(
  p: Product,
  categoryDByslug: Map<string, string>,
  publishedAt: number
): EventBody {
  const kind = p.lifecycle === "published" ? KINDS.PRODUCT : KINDS.PRODUCT_DRAFT

  const tags: string[][] = [
    ["d", p.d],
    ["title", p.title],
    ["alt", altForProduct(p)], // NIP-31; not in NIP-99, but Shopstr emits it
    ["published_at", String(publishedAt)],
  ]

  // Not in NIP-99. Emitted only when set, so a catalog without SKUs stays
  // byte-identical to what it published before this field existed.
  const sku = normalizeSku(p.sku)
  if (sku) tags.push(["sku", sku])

  if (p.price) {
    tags.push([
      "price",
      formatAmount(p.price),
      p.price.currency,
      ...(p.price.frequency ? [p.price.frequency] : []),
    ])
  }

  tags.push(
    ["type", p.type.kind, p.type.format],
    ["visibility", p.visibility],
    ["status", p.status]
  )

  if (p.summary) tags.push(["summary", p.summary])

  if (p.stock !== null) {
    const n = String(Math.max(0, Math.trunc(p.stock)))
    // GammaMarkets says `stock`, Shopstr says `quantity`. Emit both while
    // the two specs disagree, so either consumer reads a correct value.
    tags.push(["stock", n], ["quantity", n])
  }

  for (const img of [...p.images].sort((a, b) => a.order - b.order)) {
    // Dimensions are OMITTED when unknown rather than written as "0x0".
    // WooCommerce does not report them, and a made-up size is worse than no
    // size: a client that trusts it lays out a 0-pixel box.
    tags.push(
      img.width > 0 && img.height > 0
        ? ["image", img.url, `${img.width}x${img.height}`, String(img.order)]
        : ["image", img.url]
    )
  }

  // Tag ORDER encodes priority, and nostr preserves it cryptographically
  // (the event id hashes the serialised tag array), so index 0 is a durable
  // "primary category" with no extra vocabulary.
  for (const slug of p.categories) tags.push(["t", slug])
  for (const slug of p.categories) {
    const catD = categoryDByslug.get(slug)
    if (catD) tags.push(["a", coordinate(KINDS.CATEGORY, p.pubkey, catD)])
  }

  tags.push(["client", "merchant-manager"])
  tags.push(...p.unknownTags)

  return { kind, content: p.description, tags }
}

export function parseProductEvent(e: SignedEvent): ParseResult<Product> {
  if (e.kind !== KINDS.PRODUCT && e.kind !== KINDS.PRODUCT_DRAFT) {
    return { ok: false, reason: "wrong kind" }
  }

  const d = tagValue(e, "d")
  if (!d) return { ok: false, reason: "missing d tag" }

  // Our own tombstones carry ["deleted", ""] — they are not products.
  if (e.tags.some((t) => t[0] === "deleted")) {
    return { ok: false, reason: "tombstone" }
  }

  const price = parsePriceTag(e.tags.find((t) => t[0] === "price"))

  const stockRaw = tagValue(e, "stock") ?? tagValue(e, "quantity")

  const images = e.tags
    .filter((t) => t[0] === "image" && t[1])
    .map((t, i) => {
      const [w, h] = (t[2] ?? "").split("x").map((n) => Number.parseInt(n, 10))
      return {
        url: t[1]!,
        width: Number.isFinite(w) ? w! : 0,
        height: Number.isFinite(h) ? h! : 0,
        order: toInt(t[3]) ?? i,
      }
    })
    .sort((a, b) => a.order - b.order)

  return {
    ok: true,
    value: {
      d,
      posId: derivePosId(d),
      lifecycle: e.kind === KINDS.PRODUCT ? "published" : "draft",
      status: tagValue(e, "status") === "sold" ? "sold" : "active",
      title: tagValue(e, "title") ?? "(sin título)",
      summary: tagValue(e, "summary"),
      sku: normalizeSku(tagValue(e, "sku")),
      description: e.content,
      price,
      stock: stockRaw !== undefined ? (toInt(stockRaw) ?? 0) : null,
      visibility: asVisibility(tagValue(e, "visibility")) ?? "on-sale", // spec default
      type: parseTypeTag(e) ?? { kind: "simple", format: "digital" }, // spec defaults
      categories: e.tags
        .filter((t) => t[0] === "t" && t[1])
        .map((t) => slugify(t[1]!))
        .filter(Boolean),
      images,
      // Fall back to created_at, NEVER to `now` — that would rewrite history
      // every time an event without the tag is re-read.
      publishedAt: toInt(tagValue(e, "published_at")) ?? e.created_at,
      updatedAt: e.created_at,
      eventId: e.id,
      pubkey: e.pubkey,
      unknownTags: e.tags.filter((t) => t[0] && !KNOWN_TAGS.has(t[0])),
    },
  }
}

/** Is this product visible to a POS / public storefront? */
export function isPubliclyVisible(p: Product): boolean {
  return (
    p.lifecycle === "published" &&
    p.status === "active" &&
    p.visibility !== "hidden"
  )
}
