import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import { MAX_SKU_LENGTH, normalizeSku, type Product } from "@/lib/domain/product"
import { slugify } from "@/lib/domain/slug"
import type { WooProduct } from "@/lib/woo/client"

/**
 * WooCommerce product → NIP-99 product.
 *
 * Pure and total: every field is either mapped or deliberately dropped, and
 * nothing here touches the network. This is where the import is actually
 * decided, so it is the part worth testing hard.
 */

/**
 * WooCommerce descriptions are HTML; ours are Markdown, and the renderer does
 * not process raw HTML — it would show up as escaped text or vanish.
 *
 * Converting properly would mean a full HTML-to-Markdown dependency for a
 * field merchants mostly use for a paragraph or two. This keeps the structure
 * that survives the trip (paragraphs, line breaks, list items) and drops the
 * rest, which is honest and reversible: the merchant can edit it here after.
 */
export function htmlToText(html: string): string {
  if (!html) return ""

  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|tr)\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * A stable, readable SKU for a product that has none.
 *
 * Derived from the nostr `d`, so it is deterministic: re-running an import
 * proposes the same SKU rather than a second one. The hex suffix is what makes
 * it unique — two products called "Pancho" get different SKUs.
 */
export function deriveSku(d: string, title: string): string {
  const suffix = bytesToHex(sha256(utf8ToBytes(d))).slice(0, 6).toUpperCase()
  const stem = slugify(title).replace(/-/g, "").toUpperCase().slice(0, 12)
  const sku = stem ? `${stem}-${suffix}` : `MM-${suffix}`
  return sku.slice(0, MAX_SKU_LENGTH)
}

/** WooCommerce prices are decimal strings; "" means no price. */
function parseWooPrice(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface WooToProductOptions {
  storeCurrency: string
  /**
   * The nostr `d` this product will have. Passed in rather than generated
   * here so the SKU derived during planning is derived from the SAME `d` the
   * product ends up with — generating one internally silently decoupled them.
   */
  d: string
  /** The SKU decided during planning: Woo's own, or the derived one. */
  sku: string
  /** The nostr product this Woo one already maps to, if any. */
  existing?: Product
  pubkey: string
  /** Category slugs that exist in the merchant's catalog. */
  knownCategorySlugs?: ReadonlySet<string>
}

export function wooToProduct(
  woo: WooProduct,
  opts: WooToProductOptions
): Product {
  const existing = opts.existing
  const d = opts.d

  /**
   * `manage_stock: false` means the merchant is NOT tracking units, which is
   * our `null`. Mapping it to 0 would say "sold out" about a product that is
   * on the shelf — the single most damaging mistake this projection can make.
   */
  const stock = woo.manage_stock
    ? Math.max(0, Math.trunc(woo.stock_quantity ?? 0))
    : null

  // Untracked but flagged out of stock is exactly NIP-99 `status: sold`.
  const status =
    !woo.manage_stock && woo.stock_status === "outofstock" ? "sold" : "active"

  const price = parseWooPrice(woo.regular_price || woo.price)

  const categories = (woo.categories ?? [])
    .map((c) => slugify(c.slug || c.name))
    .filter((slug) => slug && (opts.knownCategorySlugs?.has(slug) ?? false))

  const image = woo.images?.[0]?.src

  return {
    d,
    posId: existing?.posId ?? 0,
    status,
    title: woo.name?.trim() || "(sin título)",
    sku: normalizeSku(opts.sku),
    summary: htmlToText(woo.short_description ?? "").slice(0, 200) || undefined,
    description: htmlToText(woo.description ?? ""),
    price: price === null ? null : { amount: price, currency: opts.storeCurrency },
    stock,
    visibility: existing?.visibility ?? "on-sale",
    type: existing?.type ?? { kind: "simple", format: "physical" },
    // Keep whatever the merchant already curated here: WooCommerce categories
    // are a different taxonomy and re-importing must not shuffle the board.
    categories: existing ? existing.categories : categories,
    /**
     * The image is REFERENCED, not re-hosted. Dimensions are 0 because the
     * WooCommerce API does not report them; the builder omits the size element
     * entirely rather than writing a made-up "0x0".
     */
    images: image ? [{ url: image, width: 0, height: 0, order: 0 }] : [],
    publishedAt: existing?.publishedAt ?? 0,
    updatedAt: existing?.updatedAt ?? 0,
    eventId: existing?.eventId ?? "",
    pubkey: opts.pubkey,
    // Never destroy tags another client put there.
    unknownTags: existing?.unknownTags ?? [],
  }
}

export type ImportAction = "create" | "update" | "skip"

export interface ImportCandidate {
  woo: WooProduct
  action: ImportAction
  /** The nostr product it matched, when updating. */
  existing?: Product
  /** The nostr `d` this will land on. Existing one, or freshly minted. */
  d: string
  /** SKU we will use — the Woo one, or derived when it had none. */
  sku: string
  /** True when the SKU has to be written BACK to WooCommerce. */
  writeSkuBack: boolean
  /** Set when action is "skip". */
  reason?: string
}

export interface ApplyImportDeps {
  storeCurrency: string
  pubkey: string
  knownCategorySlugs: ReadonlySet<string>
  /** Writes the derived SKU back to WooCommerce. Rejects on failure. */
  writeSku: (wooProductId: number, sku: string) => Promise<void>
}

export interface ApplyImportResult {
  products: Product[]
  links: { d: string; sku: string; w: number }[]
  /** Candidates left out because their SKU could not be written back. */
  skuWriteFailures: ImportCandidate[]
}

/**
 * Turn selected candidates into products, writing back SKUs as needed.
 *
 * Extracted from the dialog because this is where the import can go subtly
 * wrong, and a component is not a place you can test that.
 */
export async function applyImport(
  selected: readonly ImportCandidate[],
  deps: ApplyImportDeps
): Promise<ApplyImportResult> {
  const products: Product[] = []
  const links: { d: string; sku: string; w: number }[] = []
  const skuWriteFailures: ImportCandidate[] = []

  for (const c of selected) {
    if (c.action === "skip") continue

    /**
     * Write the SKU back FIRST, and DROP the product if that fails.
     *
     * A product imported with a SKU that exists only on our side is worse
     * than an absent one: it looks fine in the catalog, and then order sync
     * silently fails to resolve it months later with no obvious cause.
     */
    if (c.writeSkuBack) {
      try {
        await deps.writeSku(c.woo.id, c.sku)
      } catch {
        skuWriteFailures.push(c)
        continue
      }
    }

    products.push(
      wooToProduct(c.woo, {
        storeCurrency: deps.storeCurrency,
        d: c.d,
        sku: c.sku,
        existing: c.existing,
        pubkey: deps.pubkey,
        knownCategorySlugs: deps.knownCategorySlugs,
      })
    )
    links.push({ d: c.d, sku: c.sku, w: c.woo.id })
  }

  return { products, links, skuWriteFailures }
}

/**
 * Decide, for each Woo product, whether it lands as a create or an update.
 *
 * Matching is by SKU only. Matching on title would silently merge two
 * different products that happen to share a name, and that is unrecoverable
 * once published.
 */
export function planImport(
  wooProducts: readonly WooProduct[],
  catalog: readonly Product[],
  newId: () => string = () => crypto.randomUUID()
): ImportCandidate[] {
  const bySku = new Map<string, Product>()
  for (const p of catalog) {
    const sku = p.sku?.trim().toLowerCase()
    if (sku) bySku.set(sku, p)
  }

  const seen = new Set<string>()

  return wooProducts.map((woo): ImportCandidate => {
    const wooSku = normalizeSku(woo.sku)
    const existing = wooSku ? bySku.get(wooSku.toLowerCase()) : undefined
    const d = existing?.d ?? newId()
    const sku = wooSku ?? deriveSku(d, woo.name ?? "")

    // A store with two products sharing a SKU is misconfigured; importing both
    // would collapse them into one nostr product, last one winning silently.
    const key = sku.toLowerCase()
    if (seen.has(key)) {
      return {
        woo,
        action: "skip",
        d,
        sku,
        writeSkuBack: false,
        reason: `SKU repetido en WooCommerce: ${sku}`,
      }
    }
    seen.add(key)

    return existing
      ? { woo, action: "update", existing, d, sku, writeSkuBack: !wooSku }
      : { woo, action: "create", d, sku, writeSkuBack: !wooSku }
  })
}
