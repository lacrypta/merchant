import { KINDS } from "@/lib/domain/kinds"
import { derivePosId } from "@/lib/domain/pos-id"
import { slugify } from "@/lib/domain/slug"
import { nextCreatedAt } from "@/lib/nostr/created-at"
import { coordinate, tagValue, toInt } from "@/lib/nostr/tags"
import type { ParseResult, ProductImage } from "@/lib/domain/product"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

export interface Category {
  d: string
  posId: number
  name: string
  /** LOCKED after creation — equals the `t` tag on BOTH sides of the link. */
  slug: string
  /** Emitted as ["icon", "🍹"]; `emoji` is taken by NIP-30. */
  emoji?: string
  summary?: string
  image?: ProductImage
  order: number
  /** From `a` tags — the curated order of products WITHIN this category. */
  productDs: string[]
  eventId: string
  updatedAt: number
  unknownTags: string[][]
}

const KNOWN_TAGS = new Set([
  "d",
  "title",
  "order",
  "image",
  "summary",
  "icon",
  "t",
  "a",
  "alt",
  "client",
])

export function buildCategoryEvent(
  c: Category,
  pubkey: string,
  previousCreatedAt?: number
): EventTemplate {
  const created_at = nextCreatedAt(
    coordinate(KINDS.CATEGORY, pubkey, c.d),
    previousCreatedAt
  )

  const tags: string[][] = [
    ["d", c.d],
    ["title", c.name],
    ["order", String(c.order)], // custom: GammaMarkets has no ordering field
  ]

  if (c.image) {
    tags.push(["image", c.image.url, `${c.image.width}x${c.image.height}`, "0"])
  }
  if (c.summary) tags.push(["summary", c.summary])
  if (c.emoji) tags.push(["icon", c.emoji])

  // THE MEMBERSHIP BINDING. Without this the link would be `a`-only, and a
  // lost or foreign collection event would silently orphan every product in
  // it. With it, `t` is authoritative for membership (and readable by any
  // third-party client) while `a` is authoritative for ordering — so drift
  // degrades to lost ordering, never lost membership.
  tags.push(["t", c.slug])

  for (const productD of c.productDs) {
    tags.push(["a", coordinate(KINDS.PRODUCT, pubkey, productD)])
  }

  tags.push(["alt", `Colección de productos: ${c.name} (${c.productDs.length})`])
  tags.push(["client", "merchant-manager"])
  tags.push(...c.unknownTags)

  return { kind: KINDS.CATEGORY, created_at, content: "", tags }
}

/** NIP-44 v2 payloads base64 to a leading 'A'. */
const NIP44_B64 = /^A[A-Za-z0-9+/]{40,}={0,2}$/

/**
 * Guard against the kind:30405 collision.
 *
 * Shopstr uses 30405 for a NIP-44 ENCRYPTED SHOPPING CART (nips#1547);
 * GammaMarkets uses it for product collections. Reading a cart as a category
 * renders garbage — but WRITING over one would destroy a user's cart, which
 * is why this validates positively rather than blocklisting.
 *
 * The write-side rule matters even more than this read-side filter:
 * only ever publish to a `d` we generated ourselves, never to a `d` we
 * discovered, and never republish a 30405 that failed to parse.
 */
export function isOurCollection(e: SignedEvent, merchantPubkey: string): boolean {
  if (e.kind !== KINDS.CATEGORY) return false
  if (e.pubkey !== merchantPubkey) return false // only ever the merchant's own
  if (!tagValue(e, "d") || !tagValue(e, "title")) return false // carts have no title
  if (e.tags.some((t) => t[0] === "p")) return false // carts address a counterparty

  if (e.content.length > 0) {
    // Ours is always empty; an encrypted blob is definitively not ours.
    if (NIP44_B64.test(e.content.trim()) || e.content.length > 512) return false
  }

  return e.tags
    .filter((t) => t[0] === "a")
    .every((t) => /^3040[23]:[0-9a-f]{64}:/.test(t[1] ?? ""))
}

export function parseCategoryEvent(
  e: SignedEvent,
  merchantPubkey: string
): ParseResult<Category> {
  if (!isOurCollection(e, merchantPubkey)) {
    return { ok: false, reason: "not our collection" }
  }

  const d = tagValue(e, "d")!
  const name = tagValue(e, "title")!
  const imageTag = e.tags.find((t) => t[0] === "image" && t[1])

  let image: ProductImage | undefined
  if (imageTag) {
    const [w, h] = (imageTag[2] ?? "").split("x").map((n) => Number.parseInt(n, 10))
    image = {
      url: imageTag[1]!,
      width: Number.isFinite(w) ? w! : 0,
      height: Number.isFinite(h) ? h! : 0,
      order: 0,
    }
  }

  return {
    ok: true,
    value: {
      d,
      posId: derivePosId(d),
      name,
      slug: tagValue(e, "t") ?? slugify(name),
      emoji: tagValue(e, "icon"),
      summary: tagValue(e, "summary"),
      image,
      order: toInt(tagValue(e, "order")) ?? 0,
      productDs: e.tags
        .filter((t) => t[0] === "a" && t[1]?.startsWith(`${KINDS.PRODUCT}:`))
        .map((t) => t[1]!.split(":")[2] ?? "")
        .filter(Boolean),
      eventId: e.id,
      updatedAt: e.created_at,
      unknownTags: e.tags.filter((t) => t[0] && !KNOWN_TAGS.has(t[0])),
    },
  }
}
