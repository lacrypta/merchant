import { AlertTriangle } from "lucide-react"

import { AddToCartControl } from "@/components/cart/add-to-cart-control"
import { EmptyState } from "@/components/feedback/empty-state"
import { RelayLogSeed } from "@/components/nostr/relay-log-seed"
import { ProductRow } from "@/components/storefront/product-row"
import {
  StorefrontSearch,
  type SearchEntry,
} from "@/components/storefront/storefront-search"
import { toCartItem } from "@/lib/domain/cart"
import { getCatalog } from "@/lib/server/storefront"

/**
 * The products, streamed in behind their own Suspense boundary.
 *
 * Split out of the page so the header, the cart and the rest of the shell can
 * paint while this is still waiting on relays. It is the slow half by a wide
 * margin: the deletion filter it depends on is deliberately never cut short,
 * because a missed kind-5 resurrects a product the merchant deleted.
 */

/** Filtering one product is not filtering. Everything above that gets a box. */
const SEARCH_MIN_PRODUCTS = 2

export async function CatalogSection({
  pubkey,
  relayHints,
  displayName,
}: {
  pubkey: string
  relayHints: readonly string[]
  displayName: string
}) {
  const store = await getCatalog(pubkey, relayHints)

  // Decided ONCE for the whole catalog, not per row: a per-product decision
  // leaves a ragged left edge wherever one item has a photo and the next does
  // not. A merchant who uploaded nothing gets a clean text menu instead of a
  // column of placeholders.
  const showImage = store.groups.some((g) =>
    g.products.some((p) => p.images.length > 0)
  )

  /**
   * One short string per product for the search box — NOT the products.
   *
   * Built here so the row itself stays a Server Component: what crosses the
   * wire is a name, a summary and a SKU, never the markdown description.
   */
  const searchEntries: SearchEntry[] = store.groups.flatMap((g) => {
    const cat = g.category?.d ?? "__uncategorised"
    const catName = g.category?.name ?? ""
    return g.products.map((p) => ({
      d: p.d,
      cat,
      text: [p.title, p.summary ?? "", p.sku ?? "", catName].join(" "),
    }))
  })

  return (
    <>
      {/* Seeded here rather than in the layout: these are the stats of THIS
          query, and the layout no longer waits for it. */}
      <RelayLogSeed stats={store.relayLog} />

      {store.relaysUnreachable ? (
        <div
          role="alert"
          className="enter-pop mb-8 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            No pudimos alcanzar los relays. Puede que el catálogo esté incompleto —
            probá recargar en unos segundos.
          </span>
        </div>
      ) : null}

      {store.groups.length === 0 ? (
        <div className="enter-pop">
          <EmptyState
            title="Esta tienda todavía no publicó productos"
            description={`${displayName} no tiene productos activos en los relays que consultamos.`}
          />
        </div>
      ) : (
        <>
          {/* Hidden only for a one-product store, where there is nothing to
              filter down to. */}
          {searchEntries.length >= SEARCH_MIN_PRODUCTS ? (
            <StorefrontSearch entries={searchEntries} />
          ) : null}

          <div className="space-y-8">
            {store.groups.map((group, i) => {
              const key = group.category?.d ?? "__uncategorised"
              const name = group.category?.name ?? "Sin categoría"
              return (
                <section
                  key={key}
                  data-group={key}
                  // Zoom-and-fade as each section lands. Staggered by index so a
                  // catalog with five categories arrives as a cascade instead of
                  // one slab appearing at once.
                  className="enter-pop"
                  style={{ transitionDelay: `${Math.min(i, 6) * 70}ms` }}
                >
                  <h2
                    id={group.category?.slug ?? "sin-categoria"}
                    className="text-h3 mb-3 scroll-mt-20"
                  >
                    {group.category?.emoji ? (
                      <span aria-hidden className="mr-2">
                        {group.category.emoji}
                      </span>
                    ) : null}
                    {name}
                    <span
                      data-group-count=""
                      className="numeric ml-2 align-middle text-base font-medium text-muted-foreground"
                    >
                      {group.products.length}
                    </span>
                  </h2>

                  <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                    {group.products.map((p) => (
                      <li key={p.d} data-product={p.d}>
                        <ProductRow
                          product={p}
                          showImage={showImage}
                          action={<AddToCartControl item={toCartItem(p)} />}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

/**
 * Just the count, for the header chip.
 *
 * Its own component so the header does not wait for the catalog: the chip
 * streams into place beside the merchant's name once the products land.
 * `getCatalog` is React-cached, so this shares the fan-out with the list above
 * rather than starting a second one.
 */
export async function ProductCountChip({
  pubkey,
  relayHints,
}: {
  pubkey: string
  relayHints: readonly string[]
}) {
  const store = await getCatalog(pubkey, relayHints)
  if (store.productCount === 0) return null

  return (
    <span className="enter-pop inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs">
      <b className="numeric font-semibold text-primary">{store.productCount}</b>
      {store.productCount === 1 ? "producto" : "productos"}
    </span>
  )
}
