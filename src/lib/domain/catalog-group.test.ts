import { describe, expect, it } from "vitest"

import { groupCatalog } from "./catalog-group"
import type { Category } from "./category"
import type { Product } from "./product"

const PUBKEY = "a".repeat(64)

function product(over: Partial<Product> = {}): Product {
  return {
    d: "pancho",
    posId: 1,
    status: "active",
    title: "Pancho",
    summary: undefined,
    description: "",
    price: { amount: 2500, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    type: { kind: "simple", format: "physical" },
    categories: ["comida"],
    images: [],
    publishedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    eventId: "e".repeat(64),
    pubkey: PUBKEY,
    unknownTags: [],
    ...over,
  }
}

function category(over: Partial<Category> = {}): Category {
  return {
    d: "comida-1",
    posId: 2,
    name: "Comida",
    slug: "comida",
    emoji: undefined,
    summary: undefined,
    image: undefined,
    order: 0,
    productDs: [],
    eventId: "f".repeat(64),
    updatedAt: 1_700_000_000,
    unknownTags: [],
    ...over,
  }
}

describe("groupCatalog", () => {
  it("puts a product in the category its `t` tag names", () => {
    const groups = groupCatalog([product()], [category()])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.category!.name).toBe("Comida")
    expect(groups[0]!.products.map((p) => p.title)).toEqual(["Pancho"])
  })

  it("renders ONE section when two live categories share a slug", () => {
    // The reported bug. A merchant deleted "Comida" and made another with the
    // same name; when a relay read missed the kind-5, both were live, both
    // claimed every product tagged `comida`, and the section — with all its
    // items — appeared twice.
    const older = category({ d: "comida-old", updatedAt: 1_700_000_000 })
    const newer = category({ d: "comida-new", updatedAt: 1_800_000_000 })

    const groups = groupCatalog([product()], [older, newer])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.products).toHaveLength(1)
    // The one being edited wins.
    expect(groups[0]!.category!.d).toBe("comida-new")
  })

  it("does not duplicate products across a slug collision, whatever the order", () => {
    const a = category({ d: "x", updatedAt: 2 })
    const b = category({ d: "y", updatedAt: 1 })
    for (const cats of [
      [a, b],
      [b, a],
    ]) {
      const groups = groupCatalog([product(), product({ d: "choripan" })], cats)
      const rendered = groups.flatMap((g) => g.products.map((p) => p.d))
      expect(rendered).toHaveLength(new Set(rendered).size)
      expect(rendered.sort()).toEqual(["choripan", "pancho"])
    }
  })

  it("never renders the same product in two sections", () => {
    // Belonging to several categories is legal; being SHOWN twice is not.
    // Tag order is what makes index 0 the primary.
    const groups = groupCatalog(
      [product({ categories: ["comida", "bebidas"] })],
      [
        category({ d: "c", slug: "comida", order: 0 }),
        category({ d: "b", name: "Bebidas", slug: "bebidas", order: 1 }),
      ]
    )
    const rendered = groups.flatMap((g) => g.products.map((p) => p.d))
    expect(rendered).toEqual(["pancho"])
  })

  it("drops empty sections", () => {
    const groups = groupCatalog(
      [product()],
      [category(), category({ d: "v", name: "Vacía", slug: "vacia", order: 1 })]
    )
    expect(groups.map((g) => g.category!.slug)).toEqual(["comida"])
  })

  it("collects products with no known category into a trailing bucket", () => {
    const groups = groupCatalog(
      [product(), product({ d: "suelto", categories: ["inexistente"] })],
      [category()]
    )
    expect(groups).toHaveLength(2)
    expect(groups[1]!.category).toBeNull()
    expect(groups[1]!.products.map((p) => p.d)).toEqual(["suelto"])
  })

  it("orders products by the category's own `a` list, then by title", () => {
    const groups = groupCatalog(
      [
        product({ d: "b", title: "Bondiola" }),
        product({ d: "a", title: "Asado" }),
        product({ d: "z", title: "Zapallo" }),
      ],
      [category({ productDs: ["b", "a"] })]
    )
    // Curated first, in the merchant's order; anything unlisted falls to the
    // end, alphabetically.
    expect(groups[0]!.products.map((p) => p.d)).toEqual(["b", "a", "z"])
  })

  it("orders sections by `order`, then by name", () => {
    const groups = groupCatalog(
      [product(), product({ d: "birra", categories: ["bebidas"] })],
      [
        category({ d: "c", slug: "comida", order: 5 }),
        category({ d: "b", name: "Bebidas", slug: "bebidas", order: 1 }),
      ]
    )
    expect(groups.map((g) => g.category!.slug)).toEqual(["bebidas", "comida"])
  })
})
