import "server-only"

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
import { latestByAddress, queryRelays } from "@/lib/server/relay-read"

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

export interface CategoryGroup {
  category: Category | null // null = "Sin categoría"
  products: Product[]
}

export interface Storefront {
  pubkey: string
  profile: MerchantProfile | null
  groups: CategoryGroup[]
  productCount: number
  /** True when no relay answered at all — distinct from "answered, but empty". */
  relaysUnreachable: boolean
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

  const { events, unreachable } = await queryRelays(relays, [
    { kinds: [KINDS.METADATA], authors: [pubkey], limit: 1 },
    { kinds: [KINDS.PRODUCT, KINDS.CATEGORY], authors: [pubkey] },
    { kinds: [KINDS.DELETION], authors: [pubkey] },
  ])

  if (unreachable) {
    return {
      pubkey,
      profile: null,
      groups: [],
      productCount: 0,
      relaysUnreachable: true,
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
  categories.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "es-AR"))

  // `t` is authoritative for MEMBERSHIP; the category's `a` list only orders
  // within the group. So drift between the two degrades to lost ordering,
  // never to a product vanishing.
  const bySlug = new Map(categories.map((c) => [c.slug, c]))
  const grouped = new Map<string, Product[]>()
  const uncategorised: Product[] = []

  for (const p of products) {
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
  for (const c of categories) {
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

  return {
    pubkey,
    profile: parseProfile(profileEvent),
    groups,
    productCount: products.length,
    relaysUnreachable: false,
  }
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
