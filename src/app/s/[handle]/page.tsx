import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { nip19 } from "nostr-tools"

import { GridBackdrop } from "@/components/brand/grid-backdrop"
import { EmptyState } from "@/components/feedback/empty-state"
import { AddToCartControl } from "@/components/cart/add-to-cart-control"
import { EditStoreButton } from "@/components/storefront/edit-store-button"
import { CartAside } from "@/components/cart/cart-aside"
import { HandleSearchForm } from "@/components/storefront/handle-search-form"
import { ProductRow } from "@/components/storefront/product-row"
import {
  StorefrontSearch,
  type SearchEntry,
} from "@/components/storefront/storefront-search"
import { TickerChip } from "@/components/ui/ticker-chip"
import { toCartItem } from "@/lib/domain/cart"
import { getStorefront } from "@/lib/server/storefront"

/** Relay reads need Node (WebSocket), and the data is public — cache it. */
export const runtime = "nodejs"
export const revalidate = 60

type Params = Promise<{ handle: string }>

/** Filtering one product is not filtering. Everything above that gets a box. */
const SEARCH_MIN_PRODUCTS = 2

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)
  const data = await getStorefront(decoded)
  if (!data) return { title: "Tienda no encontrada" }
  const { store } = data
  const name = firstNonBlank(
    store.profile?.displayName,
    store.profile?.name,
    decoded
  )

  return {
    title: name,
    description: store.profile?.about ?? `Catálogo de ${name} en nostr.`,
    openGraph: {
      title: name,
      description: store.profile?.about ?? `Catálogo de ${name} en nostr.`,
      images: store.profile?.picture ? [store.profile.picture] : undefined,
    },
  }
}

export default async function StorefrontPage({ params }: { params: Params }) {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)

  const data = await getStorefront(decoded)
  if (!data) notFound()
  const { resolved, store } = data

  // Decided ONCE for the whole catalog, not per row: a per-product decision
  // leaves a ragged left edge wherever one item has a photo and the next does
  // not. A merchant who uploaded nothing gets a clean text menu instead of a
  // column of placeholders.
  const showImage = store.groups.some((g) =>
    g.products.some((p) => p.images.length > 0)
  )
  // Some profiles carry a blank or whitespace-only display_name; treat those
  // as absent rather than rendering an empty heading.
  const displayName = firstNonBlank(
    store.profile?.displayName,
    store.profile?.name,
    toNpub(resolved.pubkey)
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
      <main id="main" className="flex-1">
        <header className="relative border-b border-border">
          <GridBackdrop />
          <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-6 md:px-8 md:py-8">
            {store.profile?.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={store.profile.picture}
                alt=""
                className="size-14 shrink-0 rounded-full object-cover ring-2 ring-border md:size-16"
              />
            ) : (
              <div
                aria-hidden
                className="grid size-14 shrink-0 place-items-center rounded-full bg-secondary text-xl font-bold md:size-16"
              >
                {displayName.slice(0, 1).toUpperCase()}
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-1.5">
              <h1 className="text-h1 break-words">{displayName}</h1>

              <div className="flex flex-wrap items-center gap-2">
                {/* NIP-05 is identification, not verification — only show it
                    when the round trip actually resolved to this pubkey. */}
                {resolved.via === "nip05" && resolved.nip05 ? (
                  <TickerChip tone="success">{resolved.nip05}</TickerChip>
                ) : null}
                <TickerChip className="truncate-middle max-w-[16rem]">
                  {toNpub(resolved.pubkey)}
                </TickerChip>
                <EditStoreButton merchantPubkey={resolved.pubkey} />
                {store.productCount > 0 ? (
                  <TickerChip>
                    <b className="font-semibold text-primary">
                      {store.productCount}
                    </b>
                    {store.productCount === 1 ? "producto" : "productos"}
                  </TickerChip>
                ) : null}
              </div>

              {store.profile?.about ? (
                <p className="line-clamp-2 max-w-prose text-sm text-muted-foreground">
                  {store.profile.about}
                </p>
              ) : null}
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
            <div className="min-w-0 flex-1">
              {store.relaysUnreachable ? (
                <div
                  role="alert"
                  className="mb-8 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
                >
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden
                  />
                  <span>
                    No pudimos alcanzar los relays. Puede que el catálogo esté
                    incompleto — probá recargar en unos segundos.
                  </span>
                </div>
              ) : null}

              {store.groups.length === 0 ? (
                <EmptyState
                  title="Esta tienda todavía no publicó productos"
                  description={`${displayName} no tiene productos activos en los relays que consultamos.`}
                />
              ) : (
                <>
                  {/* Hidden only for a one-product store, where there is
                      nothing to filter down to. */}
                  {searchEntries.length >= SEARCH_MIN_PRODUCTS ? (
                    <StorefrontSearch entries={searchEntries} />
                  ) : null}

                  <div className="space-y-8">
                    {store.groups.map((group) => {
                      const key = group.category?.d ?? "__uncategorised"
                      const name = group.category?.name ?? "Sin categoría"
                      return (
                        <section key={key} data-group={key}>
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
                                  action={
                                    <AddToCartControl item={toCartItem(p)} />
                                  }
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
            </div>

            <CartAside />
          </div>

          <div className="mt-16 border-t border-border pt-8">
            <p className="mb-3 text-sm text-muted-foreground">
              Buscar otra tienda
            </p>
            <div className="max-w-[560px]">
              <HandleSearchForm />
            </div>
          </div>
        </div>
      </main>
    </>
  )
}

function toNpub(pubkey: string): string {
  const npub = nip19.npubEncode(pubkey)
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`
}

/**
 * Blank profile fields are common — and "blank" includes invisible
 * characters, not just whitespace. Real kind-0 events in the wild carry
 * things like U+200E (LTR mark) and zero-width spaces as a display_name,
 * which `.trim()` alone happily keeps, leaving an empty heading.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g

function firstNonBlank(...values: (string | undefined)[]): string {
  for (const v of values) {
    const cleaned = v?.replace(INVISIBLE, "").trim()
    if (cleaned) return cleaned
  }
  return ""
}
