import { describe, expect, it } from "vitest"

import { diffCatalog, type CatalogSnapshot } from "./catalog-diff"
import type { Category } from "./category"
import type { Product } from "./product"

const PUBKEY = "a".repeat(64)

function product(over: Partial<Product> = {}): Product {
  return {
    d: "fernet",
    posId: 1,
    status: "active",
    title: "Fernet con Coca",
    summary: undefined,
    description: "",
    price: { amount: 7300, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    type: { kind: "simple", format: "physical" },
    categories: [],
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
    d: "bebidas-d",
    posId: 2,
    name: "Bebidas",
    slug: "bebidas",
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

const snap = (
  products: Product[] = [],
  categories: Category[] = []
): CatalogSnapshot => ({ products, categories })

describe("diffCatalog", () => {
  it("reports nothing when the draft is untouched", () => {
    const s = snap([product()], [category()])
    const d = diffCatalog(s, s, PUBKEY)
    expect(d.count).toBe(0)
    expect(d.signatures).toBe(0)
  })

  it("survives an identical-but-not-same-object draft", () => {
    // The draft is rebuilt by setState on every edit, so structural equality
    // — not reference equality — has to be what decides.
    const d = diffCatalog(
      snap([product()], [category()]),
      snap([product()], [category()]),
      PUBKEY
    )
    expect(d.count).toBe(0)
  })

  it("flags a brand-new product and category", () => {
    const d = diffCatalog(snap(), snap([product()], [category()]), PUBKEY)
    expect(d.products.get("fernet")).toBe("new")
    expect(d.categories.get("bebidas-d")).toBe("new")
    expect(d.count).toBe(2)
    expect(d.signatures).toBe(2)
  })

  it("flags an edited product", () => {
    const d = diffCatalog(
      snap([product()]),
      snap([product({ title: "Fernet doble" })]),
      PUBKEY
    )
    expect(d.products.get("fernet")).toBe("modified")
  })

  it("notices every field that reaches the wire", () => {
    const base = snap([product()])
    const cases: Partial<Product>[] = [
      { title: "otro" },
      { price: { amount: 9000, currency: "ARS" } },
      { price: { amount: 7300, currency: "USD" } },
      { price: null },
      { stock: 5 },
      { visibility: "hidden" },
      { status: "sold" },
      { summary: "Vaso de 500ml" },
      { description: "markdown" },
      { categories: ["bebidas"] },
      { images: [{ url: "https://x/y.png", width: 256, height: 256, order: 0 }] },
      { unknownTags: [["weight", "500", "g"]] },
    ]
    for (const patch of cases) {
      const d = diffCatalog(base, snap([product(patch)]), PUBKEY)
      expect(d.products.get("fernet"), JSON.stringify(patch)).toBe("modified")
    }
  })

  it("ignores fields a relay never sees", () => {
    // posId is derived, eventId and updatedAt are metadata about the OLD
    // event. Treating those as edits would leave a permanent unsaved badge.
    const d = diffCatalog(
      snap([product()]),
      snap([product({ posId: 999, eventId: "0".repeat(64), updatedAt: 1 })]),
      PUBKEY
    )
    expect(d.count).toBe(0)
  })

  it("flags a deleted product, and charges it two signatures", () => {
    // A deletion is a kind 5 PLUS a tombstone — the merchant is told the real
    // number because with NIP-46 each one is a separate tap on their phone.
    const d = diffCatalog(snap([product()]), snap(), PUBKEY)
    expect(d.products.get("fernet")).toBe("deleted")
    expect(d.count).toBe(1)
    expect(d.signatures).toBe(2)
  })

  it("flags a deleted category at one signature", () => {
    const d = diffCatalog(snap([], [category()]), snap(), PUBKEY)
    expect(d.categories.get("bebidas-d")).toBe("deleted")
    expect(d.signatures).toBe(1)
  })

  it("notices a category reorder", () => {
    const d = diffCatalog(
      snap([], [category()]),
      snap([], [category({ order: 3 })]),
      PUBKEY
    )
    expect(d.categories.get("bebidas-d")).toBe("modified")
  })

  it("notices a product reorder WITHIN a category", () => {
    // Members live in the category's `a` tags, so dragging two products past
    // each other is a change to the category event, not to either product.
    const d = diffCatalog(
      snap([], [category({ productDs: ["a", "b"] })]),
      snap([], [category({ productDs: ["b", "a"] })]),
      PUBKEY
    )
    expect(d.categories.get("bebidas-d")).toBe("modified")
    expect(d.products.size).toBe(0)
  })

  it("notices an emoji or name change on a category", () => {
    for (const patch of [{ emoji: "🍺" }, { name: "Tragos" }]) {
      const d = diffCatalog(
        snap([], [category()]),
        snap([], [category(patch)]),
        PUBKEY
      )
      expect(d.categories.get("bebidas-d"), JSON.stringify(patch)).toBe("modified")
    }
  })

  it("marks a product moved between categories as modified", () => {
    const bebidas = category()
    const comida = category({ d: "comida-d", name: "Comida", slug: "comida", order: 1 })
    const d = diffCatalog(
      snap([product({ categories: ["bebidas"] })], [bebidas, comida]),
      snap([product({ categories: ["comida"] })], [bebidas, comida]),
      PUBKEY
    )
    expect(d.products.get("fernet")).toBe("modified")
  })

  it("counts a mixed batch correctly", () => {
    const published = snap(
      [product(), product({ d: "empanada", title: "Empanada" })],
      [category()]
    )
    const draft = snap(
      [
        product({ title: "Fernet doble" }), // modified  -> 1
        product({ d: "birra", title: "Birra" }), // new   -> 1
        // "empanada" dropped                     deleted -> 2
      ],
      [category({ order: 5 })] // modified                -> 1
    )
    const d = diffCatalog(published, draft, PUBKEY)
    expect([...d.products.entries()].sort()).toEqual([
      ["birra", "new"],
      ["empanada", "deleted"],
      ["fernet", "modified"],
    ])
    expect(d.categories.get("bebidas-d")).toBe("modified")
    expect(d.count).toBe(4)
    expect(d.signatures).toBe(5)
  })

  it("does not report a product whose category was deleted around it", () => {
    // deleteCategory() strips the slug off its members, so the members show up
    // as genuinely modified — but a member that never carried the slug must
    // stay clean.
    const published = snap([product()], [category()])
    const draft = snap([product()], [])
    const d = diffCatalog(published, draft, PUBKEY)
    expect(d.products.size).toBe(0)
    expect(d.categories.get("bebidas-d")).toBe("deleted")
  })
})

describe("a freshly published product stops showing as changed", () => {
  /**
   * The bug: a product created here starts with `publishedAt: 0` — nothing has
   * been published yet, so there is no first-publish time. The builder writes
   * `published_at = created_at` for it. When the relays hand that event back,
   * the published copy carries the real timestamp while the draft still has 0,
   * the two `published_at` tags differ, and the product is reported as
   * modified forever. Importing 31 products made it "31 cambios sin publicar"
   * that no amount of saving would clear.
   */
  const snapshot = (products: Product[]): CatalogSnapshot => ({
    products,
    categories: [],
  })

  it("is not modified once the relay copy carries a real published_at", () => {
    const draft = product({ publishedAt: 0 })
    const fromRelay = product({ publishedAt: 1_753_000_000 })

    const diff = diffCatalog(snapshot([fromRelay]), snapshot([draft]), PUBKEY)
    expect(diff.count).toBe(0)
  })

  it("still reports a real edit on a product with a placeholder timestamp", () => {
    const draft = product({ publishedAt: 0, title: "Nombre nuevo" })
    const fromRelay = product({ publishedAt: 1_753_000_000 })

    expect(diffCatalog(snapshot([fromRelay]), snapshot([draft]), PUBKEY).count).toBe(1)
  })

  it("still reports a genuine published_at change between two real timestamps", () => {
    const draft = product({ publishedAt: 1_600_000_000 })
    const fromRelay = product({ publishedAt: 1_753_000_000 })

    expect(diffCatalog(snapshot([fromRelay]), snapshot([draft]), PUBKEY).count).toBe(1)
  })
})
