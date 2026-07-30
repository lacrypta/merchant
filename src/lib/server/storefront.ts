import "server-only"

import { cache } from "react"
import { nip19 } from "nostr-tools"

import type { CartItem, CatalogIndex } from "@/lib/domain/cart"
import { groupCatalog, type CategoryGroup } from "@/lib/domain/catalog-group"
import { parseCategoryEvent, type Category } from "@/lib/domain/category"
import { KINDS } from "@/lib/domain/kinds"
import {
  isPubliclyVisible,
  parseProductEvent,
  type Product,
} from "@/lib/domain/product"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { coordinateOf, tagValue } from "@/lib/nostr/tags"
import type { SignedEvent } from "@/lib/nostr/types"
import { latestByAddress, queryRelays, type RelayStat } from "@/lib/server/relay-read"
import { resolveHandle, type ResolvedHandle } from "@/lib/server/resolve-handle"

export interface MerchantProfile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
}

export type { CategoryGroup }

export interface Storefront {
  pubkey: string
  profile: MerchantProfile | null
  groups: CategoryGroup[]
  productCount: number
  /** True when no relay answered at all — distinct from "answered, but empty". */
  relaysUnreachable: boolean
  /** What each relay contributed to this page. Feeds the navbar relay log. */
  relayLog: RelayStat[]
}

function parseProfile(e: SignedEvent | undefined): MerchantProfile | null {
  if (!e) return null
  try {
    const j = JSON.parse(e.content) as Record<string, unknown>
    const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined)
    return {
      pubkey: e.pubkey,
      name: str("name"),
      displayName: str("display_name") ?? str("displayName"),
      about: str("about"),
      picture: str("picture") ?? str("image"),
      banner: str("banner"),
      nip05: str("nip05"),
      lud16: str("lud16"),
    }
  } catch {
    return { pubkey: e.pubkey }
  }
}

/**
 * Collect NIP-09 deletions and apply the rule ourselves.
 *
 * An `a`-tag deletion covers every version up to AND INCLUDING the kind-5's
 * own created_at, so a strictly-later republish legitimately resurrects the
 * coordinate. We also require the deletion's author to match the coordinate's
 * author — NIP-09 makes that a client MUST, and a hostile relay can inject
 * anything into a subscription.
 */
function buildDeletionIndex(events: SignedEvent[]): Map<string, number> {
  const deletions = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== KINDS.DELETION) continue
    for (const t of e.tags) {
      if (t[0] !== "a" || !t[1]) continue
      const author = t[1].split(":")[1]
      if (author !== e.pubkey) continue // nobody deletes anyone else's events
      deletions.set(t[1], Math.max(deletions.get(t[1]) ?? 0, e.created_at))
    }
  }
  return deletions
}

function isDeleted(e: SignedEvent, deletions: Map<string, number>): boolean {
  const coord = coordinateOf(e)
  if (!coord) return false
  return (deletions.get(coord) ?? -1) >= e.created_at
}

/**
 * Load a merchant's public catalog.
 *
 * Only kind:30402 that are active and not hidden appear — drafts (30403)
 * never do.
 */
export async function loadStorefront(
  pubkey: string,
  relayHints: string[] = []
): Promise<Storefront> {
  const relays = dedupeRelays([...relayHints, ...DEFAULT_RELAYS])

  const { events, unreachable, stats } = await queryRelays(
    relays,
    [
      { kinds: [KINDS.METADATA], authors: [pubkey], limit: 1 },
      { kinds: [KINDS.PRODUCT, KINDS.CATEGORY], authors: [pubkey] },
      { kinds: [KINDS.DELETION], authors: [pubkey] },
    ],
    {
      label: "Catálogo, perfil y borrados",
      // Index 2 is the kind:5 read. A missed deletion resurrects a product
      // the merchant deleted, so it never gets cut short.
      completeFilters: [2],
    }
  )

  if (unreachable) {
    return {
      pubkey,
      profile: null,
      groups: [],
      productCount: 0,
      relaysUnreachable: true,
      relayLog: stats,
    }
  }

  const deletions = buildDeletionIndex(events)
  const live = events.filter((e) => !isDeleted(e, deletions))
  const addressable = latestByAddress(live.filter((e) => e.kind >= 30000))

  const profileEvent = live
    .filter((e) => e.kind === KINDS.METADATA)
    .sort((a, b) => b.created_at - a.created_at)[0]

  const products: Product[] = []
  for (const e of addressable) {
    if (e.kind !== KINDS.PRODUCT) continue
    const r = parseProductEvent(e)
    if (r.ok && isPubliclyVisible(r.value)) products.push(r.value)
  }

  const categories: Category[] = []
  for (const e of addressable) {
    if (e.kind !== KINDS.CATEGORY) continue
    const r = parseCategoryEvent(e, pubkey)
    if (r.ok) categories.push(r.value)
  }
  const groups = groupCatalog(products, categories)

  return {
    pubkey,
    profile: parseProfile(profileEvent),
    groups,
    productCount: products.length,
    relaysUnreachable: false,
    relayLog: stats,
  }
}

/**
 * The merchant themselves: who they are, and whether they can be paid.
 *
 * Split from the catalog because the two have very different costs. This is one
 * kind-0 with `limit: 1` — first relay to answer wins, ~half a second. The
 * catalog waits on a deletion filter that is deliberately never cut short, and
 * takes several. Loading them together meant the visitor stared at a skeleton
 * for the slower of the two before seeing anything at all.
 */
export const getMerchantIdentity = cache(
  async (
    handle: string
  ): Promise<{ resolved: ResolvedHandle; profile: MerchantProfile | null } | null> => {
    const resolved = await resolveHandle(handle)
    if (!resolved) return null
    const profile = await loadProfile(resolved.pubkey, resolved.relayHints)
    return { resolved, profile }
  }
)

/** The catalog on its own — the slow half. */
export const getCatalog = cache(
  async (pubkey: string, relayHints: readonly string[] = []): Promise<Storefront> =>
    loadStorefront(pubkey, [...relayHints])
)

/**
 * Resolve a handle and load its catalog, ONCE per request.
 *
 * React's `cache()` dedupes within a single render pass. Before this, the page
 * and generateMetadata each ran their own six-second relay fan-out for the
 * same merchant; now the layout, both pages and the metadata share one.
 * Cross-request caching stays ISR's job (`revalidate = 60`).
 */
export const getStorefront = cache(
  async (
    handle: string
  ): Promise<{ resolved: ResolvedHandle; store: Storefront } | null> => {
    const resolved = await resolveHandle(handle)
    if (!resolved) return null
    const store = await loadStorefront(resolved.pubkey, resolved.relayHints)
    return { resolved, store }
  }
)

/**
 * What the client is allowed to know about the merchant.
 *
 * A deliberate projection, not the whole Storefront: this crosses into a
 * client component, and shipping the full product objects (markdown
 * descriptions, unknownTags, every image) would put tens of kilobytes of
 * never-rendered payload into the RSC stream.
 */
export interface MerchantSummary {
  pubkey: string
  npub: string
  displayName: string
  picture?: string
  nip05?: string
  lud16?: string
  /** False ⇒ the merchant has no Lightning address, so nothing can be paid. */
  canCheckout: boolean
}

/**
 * Takes the PROFILE, not the whole Storefront.
 *
 * Everything here comes from kind 0, and the cart needs it before the catalog
 * exists — the storefront loads the two separately so the shell can paint
 * without waiting on the products.
 */
export function toMerchantSummary(
  resolved: ResolvedHandle,
  profile: MerchantProfile | null
): MerchantSummary {
  const displayName =
    firstNonBlank(profile?.displayName, profile?.name) ||
    `${nip19.npubEncode(resolved.pubkey).slice(0, 12)}…`

  return {
    pubkey: resolved.pubkey,
    npub: nip19.npubEncode(resolved.pubkey),
    displayName,
    picture: profile?.picture,
    // NIP-05 is identification, not verification: only surface it when the
    // domain actually resolved back to this pubkey.
    nip05: resolved.via === "nip05" ? resolved.nip05 : undefined,
    lud16: profile?.lud16,
    canCheckout: Boolean(profile?.lud16),
  }
}

/**
 * The cart-relevant slice of every product, by `d`.
 *
 * Small enough to ship whole (a few KB), and it is what lets the cart notice
 * that a stored line was deleted, repriced or sold out since it was added.
 */
export function toCatalogIndex(store: Storefront): CatalogIndex {
  const index: Record<string, CartItem> = {}
  for (const group of store.groups) {
    for (const p of group.products) {
      const thumb = p.images.find((i) => i.width === 256) ?? p.images[0]
      index[p.d] = {
        d: p.d,
        title: p.title,
        thumbUrl: thumb?.url,
        price: p.price
          ? { amount: p.price.amount, currency: p.price.currency }
          : null,
        stock: p.stock,
        visibility: p.visibility,
      }
    }
  }
  return index
}

/**
 * Blank profile fields are common, and "blank" includes invisible characters
 * — real kind-0 events carry U+200E and friends as a display_name, which
 * `.trim()` happily keeps.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g

export function firstNonBlank(...values: (string | undefined)[]): string {
  for (const v of values) {
    const cleaned = v?.replace(INVISIBLE, "").trim()
    if (cleaned) return cleaned
  }
  return ""
}

/** Profile-only lookup, for the merchant header when the catalog fails. */
export async function loadProfile(
  pubkey: string,
  relayHints: string[] = []
): Promise<MerchantProfile | null> {
  const relays = dedupeRelays([...relayHints, ...DEFAULT_RELAYS])
  const { events } = await queryRelays(
    relays,
    [{ kinds: [KINDS.METADATA], authors: [pubkey], limit: 1 }],
    { timeoutMs: 4_000 }
  )
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
  return parseProfile(newest)
}

export { tagValue }
