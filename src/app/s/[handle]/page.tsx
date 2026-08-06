import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { nip19 } from "nostr-tools"

import { GridBackdrop } from "@/components/brand/grid-backdrop"
import { CartAside } from "@/components/cart/cart-aside"
import { CurrencyToggle } from "@/components/cart/currency-toggle"
import { EditStoreButton } from "@/components/storefront/edit-store-button"
import {
  CatalogSection,
  ProductCountChip,
} from "@/components/storefront/catalog-section"
import { CatalogSkeleton } from "@/components/storefront/catalog-skeleton"
import {
  CouponChip,
  CouponSlot,
  CouponSlotSkeleton,
} from "@/components/storefront/coupon-availability"
import { Skeleton } from "@/components/ui/skeleton"
import { TickerChip } from "@/components/ui/ticker-chip"
import { getMerchantIdentity } from "@/lib/server/storefront"

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
  const data = await getMerchantIdentity(decoded)
  if (!data) return { title: "Tienda no encontrada" }

  const name = firstNonBlank(data.profile?.displayName, data.profile?.name, decoded)

  return {
    title: name,
    description: data.profile?.about ?? `Catálogo de ${name} en nostr.`,
    openGraph: {
      title: name,
      description: data.profile?.about ?? `Catálogo de ${name} en nostr.`,
      images: data.profile?.picture ? [data.profile.picture] : undefined,
    },
  }
}

/**
 * The storefront, assembled from three independent relay reads.
 *
 * Only the merchant is awaited here — one kind-0 with `limit: 1`, the fast one.
 * The catalog and the coupon announcement each stream into their own Suspense
 * boundary, so the visitor gets the shop's name and avatar in a few hundred
 * milliseconds and watches the rest arrive, instead of staring at a full-page
 * skeleton until the slowest relay has finished.
 *
 * The reads run CONCURRENTLY: rendering reaches all three boundaries before any
 * of them resolves, which is the whole reason to split them.
 */
export default async function StorefrontPage({ params }: { params: Params }) {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)

  const data = await getMerchantIdentity(decoded)
  if (!data) notFound()
  const { resolved, profile } = data
  const { pubkey, relayHints } = resolved

  // Some profiles carry a blank or whitespace-only display_name; treat those
  // as absent rather than rendering an empty heading.
  const displayName = firstNonBlank(profile?.displayName, profile?.name, toNpub(pubkey))

  return (
    <main id="main" className="flex-1">
      <header className="relative border-b border-border">
        <GridBackdrop />
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-6 md:px-8 md:py-8">
          {profile?.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.picture}
              alt=""
              className="enter-pop size-14 shrink-0 rounded-full object-cover ring-2 ring-border md:size-16"
            />
          ) : (
            <div
              aria-hidden
              className="enter-pop grid size-14 shrink-0 place-items-center rounded-full bg-secondary text-xl font-bold md:size-16"
            >
              {displayName.slice(0, 1).toUpperCase()}
            </div>
          )}

          <div className="min-w-0 flex-1 space-y-1.5">
            <h1 className="text-h1 enter-pop break-words">{displayName}</h1>

            <div className="flex flex-wrap items-center gap-2">
              {/* NIP-05 is identification, not verification — only show it
                  when the round trip actually resolved to this pubkey. */}
              {resolved.via === "nip05" && resolved.nip05 ? (
                <TickerChip tone="success">{resolved.nip05}</TickerChip>
              ) : null}
              <TickerChip className="truncate-middle max-w-[16rem]">
                {toNpub(pubkey)}
              </TickerChip>
              <EditStoreButton merchantPubkey={pubkey} />

              {/* Two chips that depend on slower reads. Each holds its place
                  with a pulse, so the row does not reflow when they land. */}
              <Suspense fallback={<ChipSkeleton width="6.5rem" />}>
                <ProductCountChip pubkey={pubkey} relayHints={relayHints} />
              </Suspense>
              <Suspense fallback={<ChipSkeleton width="8rem" />}>
                <CouponChip pubkey={pubkey} relayHints={relayHints} />
              </Suspense>
            </div>

            {profile?.about ? (
              <p className="line-clamp-2 max-w-prose text-sm text-muted-foreground">
                {profile.about}
              </p>
            ) : null}
          </div>

          {/* Every price on this page is quoted in it, so it belongs beside the
              prices rather than inside the cart it used to hide in. */}
          <CurrencyToggle className="hidden shrink-0 self-start sm:inline-flex" />
        </div>

        <div className="mx-auto -mt-2 flex w-full max-w-6xl justify-end px-4 pb-4 sm:hidden">
          <CurrencyToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <Suspense fallback={<CatalogSkeleton />}>
              <CatalogSection
                pubkey={pubkey}
                relayHints={relayHints}
                displayName={displayName}
              />
            </Suspense>
          </div>

          <CartAside
            couponSlot={
              <Suspense fallback={<CouponSlotSkeleton />}>
                <CouponSlot pubkey={pubkey} relayHints={relayHints} />
              </Suspense>
            }
          />
        </div>
      </div>
    </main>
  )
}

function ChipSkeleton({ width }: { width: string }) {
  return <Skeleton className="h-7 rounded-full" style={{ width }} />
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
