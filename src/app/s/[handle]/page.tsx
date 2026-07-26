import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { nip19 } from "nostr-tools"

import { GridBackdrop } from "@/components/brand/grid-backdrop"
import { EmptyState } from "@/components/feedback/empty-state"
import { SiteNavbar } from "@/components/shell/site-navbar"
import { HandleSearchForm } from "@/components/storefront/handle-search-form"
import { ProductTile } from "@/components/storefront/product-tile"
import { TickerChip } from "@/components/ui/ticker-chip"
import { resolveHandle } from "@/lib/server/resolve-handle"
import { loadStorefront } from "@/lib/server/storefront"

/** Relay reads need Node (WebSocket), and the data is public — cache it. */
export const runtime = "nodejs"
export const revalidate = 60

type Params = Promise<{ handle: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)
  const resolved = await resolveHandle(decoded)
  if (!resolved) return { title: "Tienda no encontrada" }

  const store = await loadStorefront(resolved.pubkey, resolved.relayHints)
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

  const resolved = await resolveHandle(decoded)
  if (!resolved) notFound()

  const store = await loadStorefront(resolved.pubkey, resolved.relayHints)
  // Some profiles carry a blank or whitespace-only display_name; treat those
  // as absent rather than rendering an empty heading.
  const displayName = firstNonBlank(
    store.profile?.displayName,
    store.profile?.name,
    toNpub(resolved.pubkey)
  )

  return (
    <>
      <SiteNavbar />

      <main id="main" className="flex-1">
        <header className="relative border-b border-border">
          <GridBackdrop />
          <div className="mx-auto flex w-full max-w-app flex-col items-center gap-5 px-4 py-12 text-center md:flex-row md:items-center md:px-8 md:text-left">
            {store.profile?.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={store.profile.picture}
                alt=""
                className="size-20 rounded-full object-cover ring-2 ring-border md:size-24"
              />
            ) : (
              <div
                aria-hidden
                className="grid size-20 place-items-center rounded-full bg-secondary text-2xl font-bold md:size-24"
              >
                {displayName.slice(0, 1).toUpperCase()}
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-2">
              <h1 className="text-display break-words">{displayName}</h1>

              <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
                {/* NIP-05 is identification, not verification — only show it
                    when the round trip actually resolved to this pubkey. */}
                {resolved.via === "nip05" && resolved.nip05 ? (
                  <TickerChip tone="success">{resolved.nip05}</TickerChip>
                ) : null}
                <TickerChip className="truncate-middle max-w-[16rem]">
                  {toNpub(resolved.pubkey)}
                </TickerChip>
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
                <p className="max-w-prose text-sm text-muted-foreground">
                  {store.profile.about}
                </p>
              ) : null}
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-app px-4 py-10 md:px-8">
          {store.relaysUnreachable ? (
            <div
              role="alert"
              className="mb-8 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
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
            <div className="space-y-12">
              {store.groups.map((group) => {
                const key = group.category?.d ?? "__uncategorised"
                const name = group.category?.name ?? "Sin categoría"
                return (
                  <section key={key}>
                    <h2
                      id={group.category?.slug ?? "sin-categoria"}
                      className="text-h2 mb-4 scroll-mt-20"
                    >
                      {group.category?.emoji ? (
                        <span aria-hidden className="mr-2">
                          {group.category.emoji}
                        </span>
                      ) : null}
                      {name}
                      <span className="numeric ml-2 align-middle text-base font-medium text-muted-foreground">
                        {group.products.length}
                      </span>
                    </h2>

                    <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                      {group.products.map((p) => (
                        <li key={p.d}>
                          <ProductTile product={p} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}

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
