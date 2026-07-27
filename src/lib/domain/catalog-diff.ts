import { categoryEventBody, type Category } from "@/lib/domain/category"
import { productEventBody, type EventBody, type Product } from "@/lib/domain/product"

/**
 * What the merchant has changed but not yet published.
 *
 * The dashboard keeps two copies of the catalog: `published`, exactly as the
 * relays returned it, and `draft`, which every edit writes to. This module is
 * the whole difference engine between them — and it is deliberately the ONLY
 * record of pending work. There is no separate queue of operations to keep in
 * sync with the UI, so "what you see" and "what will be published" cannot
 * disagree.
 *
 * A deletion is just an entry present in `published` and absent from `draft`,
 * which means undoing one is nothing more than putting it back.
 */

export type ChangeKind = "new" | "modified" | "deleted"

export interface CatalogSnapshot {
  products: Product[]
  categories: Category[]
}

export interface CatalogDiff {
  /** Keyed by `d`. */
  products: Map<string, ChangeKind>
  categories: Map<string, ChangeKind>
  /** Total changed entities — what the save bar counts. */
  count: number
  /**
   * How many events a save will actually sign. Not the same as `count`: a
   * deletion costs two (a kind 5 plus a tombstone). Worth showing, because
   * with a NIP-46 signer every event is a separate tap on the merchant's
   * phone.
   */
  signatures: number
}

export const EMPTY_DIFF: CatalogDiff = {
  products: new Map(),
  categories: new Map(),
  count: 0,
  signatures: 0,
}

/**
 * Compare on the SERIALISED EVENT BODY, not field by field.
 *
 * That makes "changed" mean precisely "would produce different bytes on a
 * relay" — so reordering a category's members counts, and touching a field
 * the builder happens to ignore does not. A hand-written field comparison
 * would drift away from the builder the first time either one is edited.
 */
function sameBody(a: EventBody, b: EventBody): boolean {
  return (
    a.kind === b.kind &&
    a.content === b.content &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  )
}

function slugMap(categories: readonly Category[]): Map<string, string> {
  return new Map(categories.map((c) => [c.slug, c.d]))
}

/**
 * A product's body depends on the category slug→d map, so it is resolved
 * against its OWN snapshot: a published product is compared as it exists on
 * the relays today, a draft product as it would be published now. That is
 * what makes "I renamed a category, so its products' `a` tags moved" show up
 * as a real change on those products.
 */
function productBody(p: Product, snapshot: CatalogSnapshot): EventBody {
  return productEventBody(p, slugMap(snapshot.categories), p.publishedAt)
}

export function diffCatalog(
  published: CatalogSnapshot,
  draft: CatalogSnapshot,
  pubkey: string
): CatalogDiff {
  const products = new Map<string, ChangeKind>()
  const categories = new Map<string, ChangeKind>()

  const publishedProducts = new Map(published.products.map((p) => [p.d, p]))
  const publishedCategories = new Map(published.categories.map((c) => [c.d, c]))

  for (const p of draft.products) {
    const before = publishedProducts.get(p.d)
    if (!before) {
      products.set(p.d, "new")
    } else if (!sameBody(productBody(before, published), productBody(p, draft))) {
      products.set(p.d, "modified")
    }
  }
  for (const p of published.products) {
    if (!draft.products.some((x) => x.d === p.d)) products.set(p.d, "deleted")
  }

  for (const c of draft.categories) {
    const before = publishedCategories.get(c.d)
    if (!before) {
      categories.set(c.d, "new")
    } else if (
      !sameBody(categoryEventBody(before, pubkey), categoryEventBody(c, pubkey))
    ) {
      categories.set(c.d, "modified")
    }
  }
  for (const c of published.categories) {
    if (!draft.categories.some((x) => x.d === c.d)) categories.set(c.d, "deleted")
  }

  let signatures = 0
  for (const kind of products.values()) signatures += kind === "deleted" ? 2 : 1
  for (const kind of categories.values()) signatures += kind === "deleted" ? 1 : 1

  return {
    products,
    categories,
    count: products.size + categories.size,
    signatures,
  }
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  new: "Nuevo",
  modified: "Modificado",
  deleted: "Eliminado",
}
