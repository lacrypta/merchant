import type { Category } from "@/lib/domain/category"
import type { Product } from "@/lib/domain/product"

export interface CategoryGroup {
  category: Category | null // null = "Sin categoría"
  products: Product[]
}

/**
 * Arrange a catalog into the sections a storefront renders.
 *
 * Pure and separate from the relay read because this is where a visible bug
 * lived: two live categories sharing a slug each claimed the same products,
 * so a merchant who deleted "Comida" and recreated it saw the section twice
 * with every item duplicated inside it.
 *
 * `t` (the slug) is authoritative for MEMBERSHIP; a category's `a` list only
 * orders products WITHIN its group. Drift between the two therefore costs
 * ordering, never a product disappearing.
 */
export function groupCatalog(
  products: readonly Product[],
  categories: readonly Category[]
): CategoryGroup[] {
  const sorted = [...categories].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, "es-AR")
  )

  // One section per slug. Newest wins — it is the one being edited.
  const bySlug = new Map<string, Category>()
  for (const c of sorted) {
    const existing = bySlug.get(c.slug)
    if (!existing || c.updatedAt > existing.updatedAt) bySlug.set(c.slug, c)
  }

  const grouped = new Map<string, Product[]>()
  const uncategorised: Product[] = []

  for (const p of products) {
    // The FIRST slug the merchant actually has a category for wins; that is
    // the primary category, and tag order is what encodes priority.
    const primary = p.categories.find((s) => bySlug.has(s))
    if (primary) {
      const list = grouped.get(primary) ?? []
      list.push(p)
      grouped.set(primary, list)
    } else {
      uncategorised.push(p)
    }
  }

  const groups: CategoryGroup[] = []
  for (const c of sorted) {
    // Skip the losers of a slug collision, or their products render twice.
    if (bySlug.get(c.slug) !== c) continue
    const list = grouped.get(c.slug)
    if (!list?.length) continue

    const order = new Map(c.productDs.map((d, i) => [d, i]))
    list.sort(
      (a, b) =>
        (order.get(a.d) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.d) ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title, "es-AR")
    )
    groups.push({ category: c, products: list })
  }

  if (uncategorised.length) {
    uncategorised.sort((a, b) => a.title.localeCompare(b.title, "es-AR"))
    groups.push({ category: null, products: uncategorised })
  }

  return groups
}
