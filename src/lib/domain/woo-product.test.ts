import { beforeEach, describe, expect, it } from "vitest"

import type { WooProduct } from "@/lib/woo/client"
import { buildProductEvent, parseProductEvent, type Product } from "./product"
import { diffCatalog } from "./catalog-diff"
import { __resetCreatedAtState } from "@/lib/nostr/created-at"
import {
  applyImport,
  deriveSku,
  htmlToText,
  planImport,
  wooToProduct,
} from "./woo-product"

const PUBKEY = "a".repeat(64)

beforeEach(() => {
  __resetCreatedAtState()
})

const woo = (over: Partial<WooProduct> = {}): WooProduct => ({
  id: 10,
  name: "Pancho",
  sku: "EMP-001",
  status: "publish",
  description: "<p>Con papas</p>",
  short_description: "",
  price: "1500.00",
  regular_price: "1500.00",
  manage_stock: true,
  stock_quantity: 7,
  stock_status: "instock",
  images: [{ id: 1, src: "https://tienda.example/pancho.jpg" }],
  categories: [{ id: 3, name: "Comida", slug: "comida" }],
  ...over,
})

const existing = (over: Partial<Product> = {}): Product => ({
  d: "existing-d",
  posId: 42,
  lifecycle: "published",
  status: "active",
  title: "Viejo",
  sku: "EMP-001",
  description: "",
  price: { amount: 1, currency: "ARS" },
  stock: null,
  visibility: "hidden",
  type: { kind: "simple", format: "digital" },
  categories: ["bebidas"],
  images: [],
  publishedAt: 1_600_000_000,
  updatedAt: 1_600_000_100,
  eventId: "e".repeat(64),
  pubkey: PUBKEY,
  unknownTags: [["weight", "500"]],
  ...over,
})

const convert = (w: WooProduct, over: Partial<Parameters<typeof wooToProduct>[1]> = {}) =>
  wooToProduct(w, {
    storeCurrency: "ARS",
    d: "new-d",
    sku: w.sku || "GEN-1",
    pubkey: PUBKEY,
    ...over,
  })

describe("stock mapping", () => {
  it("maps a tracked quantity", () => {
    expect(convert(woo({ manage_stock: true, stock_quantity: 7 })).stock).toBe(7)
  })

  it("maps UNTRACKED to null, never 0", () => {
    // Mapping it to 0 would say "sold out" about a product on the shelf —
    // the most damaging mistake this projection can make.
    expect(convert(woo({ manage_stock: false, stock_quantity: null })).stock).toBeNull()
  })

  it("keeps a tracked zero as zero", () => {
    expect(convert(woo({ manage_stock: true, stock_quantity: 0 })).stock).toBe(0)
  })

  it("treats a null quantity on a tracked product as zero", () => {
    expect(convert(woo({ manage_stock: true, stock_quantity: null })).stock).toBe(0)
  })

  it("clamps a negative backorder count", () => {
    expect(convert(woo({ manage_stock: true, stock_quantity: -3 })).stock).toBe(0)
  })

  it("marks untracked + outofstock as sold", () => {
    const p = convert(woo({ manage_stock: false, stock_status: "outofstock" }))
    expect(p.status).toBe("sold")
    expect(p.stock).toBeNull()
  })

  it("does not mark a tracked zero as sold", () => {
    expect(convert(woo({ manage_stock: true, stock_quantity: 0 })).status).toBe("active")
  })
})

describe("price mapping", () => {
  it("uses regular_price with the store currency", () => {
    expect(convert(woo({ regular_price: "2500.50" })).price).toEqual({
      amount: 2500.5,
      currency: "ARS",
    })
  })

  it("falls back to price when regular_price is empty", () => {
    expect(convert(woo({ regular_price: "", price: "999" })).price?.amount).toBe(999)
  })

  it("is null when the product has no price at all", () => {
    // NIP-99 allows it; the storefront renders "Consultar precio".
    expect(convert(woo({ regular_price: "", price: "" })).price).toBeNull()
  })

  it("is null for a garbage price rather than NaN", () => {
    expect(convert(woo({ regular_price: "abc", price: "" })).price).toBeNull()
  })
})

describe("images", () => {
  it("references the first Woo image with unknown dimensions", () => {
    expect(convert(woo()).images).toEqual([
      { url: "https://tienda.example/pancho.jpg", width: 0, height: 0, order: 0 },
    ])
  })

  it("is empty when the product has no image", () => {
    expect(convert(woo({ images: [] })).images).toEqual([])
  })
})

describe("preserving what the merchant already has", () => {
  it("keeps d, publishedAt, posId and unknownTags on update", () => {
    const prev = existing()
    const p = convert(woo(), { d: prev.d, existing: prev })
    expect(p.d).toBe("existing-d")
    expect(p.publishedAt).toBe(1_600_000_000)
    expect(p.posId).toBe(42)
    // Re-emitted verbatim: never destroy another client's data.
    expect(p.unknownTags).toEqual([["weight", "500"]])
  })

  it("keeps the merchant's own categories on update", () => {
    // WooCommerce categories are a different taxonomy; re-importing must not
    // shuffle the board the merchant arranged.
    const prev = existing({ categories: ["bebidas"] })
    expect(convert(woo(), { d: prev.d, existing: prev }).categories).toEqual(["bebidas"])
  })

  it("keeps the merchant's visibility on update", () => {
    const prev = existing({ visibility: "hidden" })
    expect(convert(woo(), { d: prev.d, existing: prev }).visibility).toBe("hidden")
  })

  it("only adopts Woo categories that already exist here", () => {
    const p = convert(woo(), { knownCategorySlugs: new Set(["comida"]) })
    expect(p.categories).toEqual(["comida"])
    expect(convert(woo(), { knownCategorySlugs: new Set() }).categories).toEqual([])
  })
})

describe("htmlToText", () => {
  it("keeps paragraph breaks", () => {
    expect(htmlToText("<p>Uno</p><p>Dos</p>")).toBe("Uno\n\nDos")
  })

  it("keeps list items as markdown bullets", () => {
    expect(htmlToText("<ul><li>Uno</li><li>Dos</li></ul>")).toBe("- Uno\n- Dos")
  })

  it("turns br into a newline", () => {
    expect(htmlToText("a<br/>b")).toBe("a\nb")
  })

  it("decodes entities", () => {
    expect(htmlToText("Ca&ntilde;a &amp; Coca &#39;fria&#39;")).toContain("& Coca 'fria'")
  })

  it("strips scripts and attributes rather than leaving markup", () => {
    expect(htmlToText('<a href="x" onclick="evil()">link</a>')).toBe("link")
    expect(htmlToText("<script>alert(1)</script>hola")).toBe("alert(1)hola")
  })

  it("handles empty input", () => {
    expect(htmlToText("")).toBe("")
  })
})

describe("deriveSku", () => {
  it("is deterministic for the same d", () => {
    // Re-running an import must propose the SAME sku, not a second one.
    expect(deriveSku("d-1", "Pancho")).toBe(deriveSku("d-1", "Pancho"))
  })

  it("differs for two products with the same name", () => {
    expect(deriveSku("d-1", "Pancho")).not.toBe(deriveSku("d-2", "Pancho"))
  })

  it("is readable and uppercase", () => {
    expect(deriveSku("d-1", "Fernet con Coca")).toMatch(/^FERNETCONCOC-[0-9A-F]{6}$/)
  })

  it("copes with a title that slugifies to nothing", () => {
    expect(deriveSku("d-1", "🍕🍕")).toMatch(/^MM-[0-9A-F]{6}$/)
  })
})

describe("planImport", () => {
  let n = 0
  const newId = () => `new-${++n}`

  it("creates when no SKU matches", () => {
    n = 0
    const [c] = planImport([woo({ sku: "NEW-1" })], [], newId)
    expect(c).toMatchObject({ action: "create", sku: "NEW-1", writeSkuBack: false })
  })

  it("updates when the SKU matches an existing product", () => {
    n = 0
    const [c] = planImport([woo({ sku: "EMP-001" })], [existing()], newId)
    expect(c?.action).toBe("update")
    expect(c?.existing?.d).toBe("existing-d")
    expect(c?.d).toBe("existing-d")
  })

  it("matches case-insensitively", () => {
    n = 0
    const [c] = planImport([woo({ sku: "emp-001" })], [existing()], newId)
    expect(c?.action).toBe("update")
  })

  it("derives a SKU and flags it to be written back", () => {
    n = 0
    const [c] = planImport([woo({ sku: "" })], [], newId)
    expect(c?.writeSkuBack).toBe(true)
    // The derived SKU must come from the very `d` the product will carry.
    expect(c?.sku).toBe(deriveSku(c!.d, "Pancho"))
  })

  it("skips the second of two Woo products sharing a SKU", () => {
    // Importing both would collapse them into one nostr product, silently.
    n = 0
    const plan = planImport(
      [woo({ id: 1, sku: "DUP" }), woo({ id: 2, sku: "DUP" })],
      [],
      newId
    )
    expect(plan[0]?.action).toBe("create")
    expect(plan[1]?.action).toBe("skip")
    expect(plan[1]?.reason).toContain("DUP")
  })

  it("never matches on title", () => {
    // Two different products that share a name must stay separate.
    n = 0
    const plan = planImport([woo({ sku: "OTHER" })], [existing({ title: "Pancho" })], newId)
    expect(plan[0]?.action).toBe("create")
  })
})

describe("applyImport", () => {
  const deps = (
    writeSku: (id: number, sku: string) => Promise<void> = async () => {}
  ) => ({
    storeCurrency: "ARS",
    pubkey: PUBKEY,
    knownCategorySlugs: new Set<string>(),
    writeSku,
  })

  it("converts the selected candidates and links them", async () => {
    const plan = planImport([woo({ sku: "A-1" })], [], () => "d-1")
    const res = await applyImport(plan, deps())
    expect(res.products).toHaveLength(1)
    expect(res.products[0]?.sku).toBe("A-1")
    expect(res.links).toEqual([{ d: "d-1", sku: "A-1", w: 10 }])
    expect(res.skuWriteFailures).toHaveLength(0)
  })

  it("writes a derived SKU back to WooCommerce", async () => {
    const calls: [number, string][] = []
    const plan = planImport([woo({ sku: "" })], [], () => "d-1")
    await applyImport(
      plan,
      deps(async (id, sku) => {
        calls.push([id, sku])
      })
    )
    expect(calls).toEqual([[10, plan[0]!.sku]])
  })

  it("does NOT rewrite a SKU the store already had", async () => {
    let called = false
    const plan = planImport([woo({ sku: "A-1" })], [], () => "d-1")
    await applyImport(plan, deps(async () => {
      called = true
    }))
    expect(called).toBe(false)
  })

  it("DROPS a product whose SKU write-back failed", async () => {
    // A product with a SKU that exists only on our side looks fine in the
    // catalog and then breaks order sync months later with no visible cause.
    const plan = planImport([woo({ sku: "" })], [], () => "d-1")
    const res = await applyImport(
      plan,
      deps(async () => {
        throw new Error("403")
      })
    )
    expect(res.products).toHaveLength(0)
    expect(res.links).toHaveLength(0)
    expect(res.skuWriteFailures).toHaveLength(1)
  })

  it("keeps going after one failure", async () => {
    const plan = planImport(
      [woo({ id: 1, sku: "" }), woo({ id: 2, sku: "OK-2" })],
      [],
      (() => {
        let n = 0
        return () => `d-${++n}`
      })()
    )
    const res = await applyImport(
      plan,
      deps(async () => {
        throw new Error("403")
      })
    )
    expect(res.products.map((p) => p.sku)).toEqual(["OK-2"])
    expect(res.skuWriteFailures).toHaveLength(1)
  })

  it("ignores candidates marked skip", async () => {
    const plan = planImport(
      [woo({ id: 1, sku: "DUP" }), woo({ id: 2, sku: "DUP" })],
      [],
      () => "d-1"
    )
    const res = await applyImport(plan, deps())
    expect(res.products).toHaveLength(1)
  })
})

describe("round trip: import → publish → read back → diff", () => {
  /**
   * The invariant that "31 cambios sin publicar" violated: publishing an
   * imported product and reading it back off the relays must produce NO
   * pending change. Anything asymmetric between the builder and the parser
   * shows up here instead of as a badge the merchant cannot clear.
   */
  const roundTrip = (w: WooProduct, storeCurrency = "ARS") => {
    const [c] = planImport([w], [], () => "d-1")
    const imported = wooToProduct(w, {
      storeCurrency,
      d: c!.d,
      sku: c!.sku,
      pubkey: PUBKEY,
      knownCategorySlugs: new Set(["comida"]),
    })

    // What actually goes on the wire, then what a relay hands back.
    const event = buildProductEvent(imported, new Map())
    const parsed = parseProductEvent({
      ...event,
      id: "f".repeat(64),
      pubkey: PUBKEY,
      sig: "s".repeat(128),
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("unparseable")

    const snapshot = (p: Product) => ({ products: [p], categories: [] })
    return {
      parsed: parsed.value,
      diff: diffCatalog(snapshot(parsed.value), snapshot(imported), PUBKEY),
    }
  }

  it("shows no pending change for a fully-populated product", () => {
    expect(roundTrip(woo()).diff.count).toBe(0)
  })

  it("shows no pending change for a product with no image and no stock", () => {
    expect(
      roundTrip(woo({ images: [], manage_stock: false, stock_quantity: null })).diff
        .count
    ).toBe(0)
  })

  it("shows no pending change for a product with no price", () => {
    expect(roundTrip(woo({ regular_price: "", price: "" })).diff.count).toBe(0)
  })

  it("shows no pending change for a derived SKU", () => {
    expect(roundTrip(woo({ sku: "" })).diff.count).toBe(0)
  })

  it("shows no pending change for a sold-out untracked product", () => {
    expect(
      roundTrip(woo({ manage_stock: false, stock_status: "outofstock" })).diff.count
    ).toBe(0)
  })

  it("keeps the image URL and reports no size it does not know", () => {
    const { parsed } = roundTrip(woo())
    expect(parsed.images[0]?.url).toBe("https://tienda.example/pancho.jpg")
    expect(parsed.images[0]?.width).toBe(0)
  })

  it("preserves a decimal price through the round trip", () => {
    const { parsed } = roundTrip(woo({ regular_price: "1234.56" }))
    expect(parsed.price).toEqual({ amount: 1234.56, currency: "ARS" })
  })
})
