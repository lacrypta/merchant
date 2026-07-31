"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { usePublishMonitor } from "@/components/publish/publish-monitor"
import {
  buildCategoryEvent,
  parseCategoryEvent,
  type Category,
} from "@/lib/domain/category"
import {
  EMPTY_DIFF,
  diffCatalog,
  type CatalogDiff,
  type CatalogSnapshot,
} from "@/lib/domain/catalog-diff"
import { KINDS } from "@/lib/domain/kinds"
import {
  WOO_CONFIG_D,
  buildAppDataEvent,
  isOurWooConfig,
} from "@/lib/domain/woo-config"
import { WOO_SYNC_D } from "@/lib/domain/woo-sync-state"
import {
  buildProductEvent,
  parseProductEvent,
  type Product,
} from "@/lib/domain/product"
import {
  buildRelayListEvent,
  mergeWithDefaults,
  parseRelayListEvent,
  writeRelays,
  type RelayEntry,
} from "@/lib/domain/relay-list"
import { nextCreatedAt, nowSeconds } from "@/lib/nostr/created-at"
import { queryEvents } from "@/lib/nostr/backend"
import { CACHE, qk } from "@/lib/query/keys"
import {
  readRelayEntries,
  useRelayPrefs,
  writeRelayEntries,
} from "@/lib/nostr/relay-prefs"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { coordinate, coordinateOf, tagValue } from "@/lib/nostr/tags"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * The catalog, as two snapshots.
 *
 * `published` is what the relays returned. `draft` is what the merchant is
 * looking at. Every edit writes only to `draft`; nothing reaches a relay
 * until saveChanges().
 *
 * Why staged rather than write-through: editing a catalog is a burst
 * activity. Renaming three products and dragging one between categories used
 * to be five signature prompts — and on a NIP-46 signer that is five separate
 * taps on the merchant's phone, each with its own chance to fail halfway and
 * leave the catalog in a state nobody chose. Batching turns that into one
 * deliberate act with a number attached to it.
 */
interface CatalogContextValue {
  loading: boolean
  /** The DRAFT catalog — what the UI renders and edits. */
  products: Product[]
  categories: Category[]
  relayEntries: RelayEntry[]
  /** Which entities differ from the published version, and how. */
  changes: CatalogDiff
  /** True while a save is draining through the publish queue. */
  saving: boolean
  /** True while a background refresh runs over data already on screen. */
  syncing: boolean
  /** d-tags with an in-flight write, for the dimmed row treatment. */
  pending: Set<string>
  refresh: () => Promise<void>
  saveProduct: (p: Product) => void
  /**
   * Upsert many at once. One state update instead of N — an import of 200
   * products through saveProduct would re-render the board 200 times.
   */
  saveProducts: (list: Product[]) => void
  deleteProduct: (p: Product) => void
  saveCategory: (c: Category) => void
  deleteCategory: (c: Category, reassign: "orphan" | "delete") => void
  /** Publish everything staged. The only thing that writes to a relay. */
  saveChanges: () => void
  /** Throw the draft away and go back to what is published. */
  discardChanges: () => void
  setRelayEntries: (entries: RelayEntry[]) => void
  publishRelayList: () => void
  /**
   * Live kind-30403 drafts left on relays from before the draft feature was
   * removed. Surfaced as a one-time migration banner on /products.
   */
  legacyDrafts: LegacyDraft[]
  /** Publish a kind 5 + tombstone for every legacy draft. */
  sweepLegacyDrafts: () => void
  /** Raw NIP-78 events for our own `d` tags. Still encrypted. */
  appData: SignedEvent[]
  /**
   * Publish a NIP-78 blob under one of OUR `d` tags.
   *
   * `ciphertext` must already be sealed — this cannot check that, so the one
   * call path that builds it is the one that encrypts.
   */
  publishAppData: (d: string, ciphertext: string, label: string) => void
}

const CatalogContext = React.createContext<CatalogContextValue | null>(null)

const EMPTY_SNAPSHOT: CatalogSnapshot = { products: [], categories: [] }
/** Stable reference: a fresh [] each render would re-run every consumer memo. */
const EMPTY_APP_DATA: SignedEvent[] = []
const EMPTY_LEGACY_DRAFTS: LegacyDraft[] = []

/** The bare minimum needed to address and label a stale 30403 for deletion. */
export interface LegacyDraft {
  d: string
  title: string
}

/**
 * The merchant's saved relay record, or null if they have never touched it.
 *
 * Goes through relay-prefs so this screen and the navbar relay panel share
 * one cache and one writer — otherwise toggling a relay in one place leaves
 * the other showing the old value for the rest of the session.
 */
function readStoredRelays(): RelayEntry[] | null {
  const entries = readRelayEntries()
  return entries.length > 0 ? entries : null
}

/**
 * Apply NIP-09 ourselves.
 *
 * An `a`-tag deletion covers every version up to AND INCLUDING the kind-5's
 * own created_at, so a strictly-later republish legitimately resurrects the
 * coordinate — that is our undo. The deletion's author must match the
 * coordinate's author; NIP-09 makes that check a client MUST.
 */
function buildDeletionIndex(events: SignedEvent[]): Map<string, number> {
  const deletions = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== KINDS.DELETION) continue
    for (const t of e.tags) {
      if (t[0] !== "a" || !t[1]) continue
      if (t[1].split(":")[1] !== e.pubkey) continue
      deletions.set(t[1], Math.max(deletions.get(t[1]) ?? 0, e.created_at))
    }
  }
  return deletions
}

/** NIP-01: newest wins; on an equal created_at the LOWEST event id wins. */
function latestByAddress(events: SignedEvent[]): SignedEvent[] {
  const best = new Map<string, SignedEvent>()
  for (const e of events) {
    const key = coordinateOf(e)
    if (!key) continue
    const cur = best.get(key)
    if (
      !cur ||
      e.created_at > cur.created_at ||
      (e.created_at === cur.created_at && e.id < cur.id)
    ) {
      best.set(key, e)
    }
  }
  return [...best.values()]
}

const byOrderThenName = (a: Category, b: Category) =>
  a.order - b.order || a.name.localeCompare(b.name, "es-AR")

interface CatalogRead {
  snapshot: CatalogSnapshot
  /** Stale 30403 drafts still live on relays, pending the migration sweep. */
  legacyDrafts: LegacyDraft[]
  /** The merchant's published NIP-65 list, if they have one. */
  relayList: RelayEntry[] | null
  /**
   * Raw NIP-78 app-data events, still encrypted.
   *
   * Carried on this read rather than a separate one: it is one more filter on
   * a round trip that already happens, and decrypting needs the signer, which
   * this function does not have.
   */
  appData: SignedEvent[]
}

/**
 * Read the merchant's whole catalog off their relays.
 *
 * Extracted out of the provider so react-query owns it: the result is
 * persisted to IndexedDB, which is what lets the dashboard paint a full
 * catalog on the first frame after a reload instead of four skeleton cards
 * for however long the slowest relay takes.
 */
async function readCatalog(
  pubkey: string,
  readUrls: string[]
): Promise<CatalogRead> {
  const events = await queryEvents(
    [
      {
        // 30403 is still read even though nothing writes drafts any more: the
        // sweep below is the only thing that can find a leftover from before
        // the feature was removed, and without this kind it never sees one.
        kinds: [KINDS.PRODUCT, KINDS.PRODUCT_DRAFT, KINDS.CATEGORY],
        authors: [pubkey],
      },
      { kinds: [KINDS.DELETION], authors: [pubkey] },
      { kinds: [KINDS.RELAY_LIST], authors: [pubkey] },
      {
        kinds: [KINDS.APP_DATA],
        authors: [pubkey],
        // Scoped to OUR `d` tags: kind 30078 is shared by every app that
        // stores per-user data, and pulling all of them would drag down
        // unrelated blobs on every catalog load.
        "#d": [WOO_CONFIG_D, WOO_SYNC_D],
      },
    ],
    readUrls,
    { label: "Catálogo, borrados, relays y config" }
  )

  const deletions = buildDeletionIndex(events)
  const live = events.filter((e) => {
    const coord = coordinateOf(e)
    return !coord || (deletions.get(coord) ?? -1) < e.created_at
  })

  const addressable = latestByAddress(live.filter((e) => e.kind >= 30000))

  const products: Product[] = []
  const categories: Category[] = []
  const legacyDrafts: LegacyDraft[] = []
  for (const e of addressable) {
    if (e.kind === KINDS.PRODUCT) {
      const r = parseProductEvent(e)
      if (r.ok) products.push(r.value)
    } else if (e.kind === KINDS.PRODUCT_DRAFT) {
      // The draft feature is gone. Whatever still lives at 30403 — except our
      // own tombstones — is a leftover to sweep, even when the same `d` also
      // exists at 30402 (the old dual-coordinate ghost).
      if (!e.tags.some((t) => t[0] === "deleted")) {
        legacyDrafts.push({
          d: tagValue(e, "d") ?? "",
          title: tagValue(e, "title") ?? "(sin título)",
        })
      }
    } else if (e.kind === KINDS.CATEGORY) {
      const r = parseCategoryEvent(e, pubkey)
      if (r.ok) categories.push(r.value)
    }
  }
  categories.sort(byOrderThenName)

  const relayEvent = live
    .filter((e) => e.kind === KINDS.RELAY_LIST)
    .sort((a, b) => b.created_at - a.created_at)[0]

  return {
    snapshot: { products, categories },
    legacyDrafts: legacyDrafts.filter((ld) => ld.d),
    relayList: relayEvent ? parseRelayListEvent(relayEvent) : null,
    appData: latestByAddress(live.filter((e) => e.kind === KINDS.APP_DATA)),
  }
}

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const { state, signer } = useAuth()
  const { enqueue } = usePublishMonitor()
  const queryClient = useQueryClient()
  const pubkey = state.status === "ready" ? state.pubkey : null

  const [draft, setDraft] = React.useState<CatalogSnapshot>(EMPTY_SNAPSHOT)
  /**
   * Relays come from the SHARED record, not a local copy.
   *
   * A private copy meant the navbar relay panel could switch a relay off
   * while this provider kept publishing to it — and, worse, the copy was
   * seeded from the defaults and never hydrated, so a merchant's saved relay
   * settings were silently ignored on every load.
   *
   * `useRelayPrefs()` returns [] on the server and on the first client paint,
   * which merges to exactly the defaults the server rendered with.
   */
  const storedRelays = useRelayPrefs()
  const [nip65Relays, setNip65Relays] = React.useState<RelayEntry[]>([])
  const relayEntries = React.useMemo(
    // Three LAYERS, weakest first: defaults < the merchant's published NIP-65
    // list < this browser's saved record. Layering rather than replacing,
    // because the saved record can be a single entry — switching one relay off
    // in the navbar panel writes exactly one — and treating that as the whole
    // list made the merchant's own NIP-65 relays vanish from the publish set
    // the moment they touched the switch.
    () => mergeWithDefaults([...nip65Relays, ...storedRelays], DEFAULT_RELAYS),
    [storedRelays, nip65Relays]
  )
  const [pending, setPending] = React.useState<Set<string>>(new Set())
  /**
   * Derived, not stored: "we have work in flight" is exactly what `pending`
   * already means. A separate boolean would have to be set before enqueue and
   * cleared after the last settle, and getting that ordering wrong shows a
   * spinner that never stops.
   */
  const saving = pending.size > 0

  // Mirrored into refs so async queue callbacks read CURRENT values without
  // being re-created on every edit. Written in effects, never during render.
  const relayEntriesRef = React.useRef(relayEntries)
  const draftRef = React.useRef(draft)
  React.useEffect(() => {
    relayEntriesRef.current = relayEntries
  }, [relayEntries])
  React.useEffect(() => {
    draftRef.current = draft
  }, [draft])

  const setRelayEntries = React.useCallback((entries: RelayEntry[]) => {
    // No local setState: `relayEntries` derives from this write.
    writeRelayEntries(entries)
  }, [])

  /**
   * Read relays: the merchant's local edits win over both NIP-65 and the
   * defaults, so removing a relay does not see it reappear on the next load.
   */
  const readUrls = React.useMemo(
    () =>
      dedupeRelays([
        ...relayEntries.filter((e) => e.read).map((e) => e.url),
        ...DEFAULT_RELAYS,
      ]),
    [relayEntries]
  )

  const catalogQuery = useQuery({
    queryKey: qk.catalog(pubkey ?? ""),
    queryFn: () => readCatalog(pubkey!, readUrls),
    enabled: !!pubkey,
    ...CACHE.catalog,
  })

  const loading = catalogQuery.isPending && !!pubkey
  /** A refresh running over data already on screen — drives the sync badge. */
  const syncing = catalogQuery.isFetching && !catalogQuery.isPending

  const published = catalogQuery.data?.snapshot ?? EMPTY_SNAPSHOT
  const appData = React.useMemo(
    () => catalogQuery.data?.appData ?? EMPTY_APP_DATA,
    [catalogQuery.data]
  )
  // `?? EMPTY` also covers caches persisted before the field existed.
  const legacyDrafts = catalogQuery.data?.legacyDrafts ?? EMPTY_LEGACY_DRAFTS

  const publishedRef = React.useRef(published)
  React.useEffect(() => {
    publishedRef.current = published
  }, [published])

  const changes = React.useMemo(
    () => (pubkey ? diffCatalog(published, draft, pubkey) : EMPTY_DIFF),
    [published, draft, pubkey]
  )

  /**
   * Move one entity from the draft into the published baseline.
   *
   * Writes straight into the query cache rather than a second piece of state,
   * so "what the relays have" lives in exactly one place. Called only when an
   * event actually landed, which is what leaves a FAILED item still badged as
   * unsaved instead of optimistically pretending it went out.
   */
  const advanceRead = React.useCallback(
    (mutate: (prev: CatalogRead) => CatalogRead) => {
      if (!pubkey) return
      queryClient.setQueryData<CatalogRead>(qk.catalog(pubkey), (old) =>
        mutate({
          relayList: old?.relayList ?? null,
          appData: old?.appData ?? EMPTY_APP_DATA,
          legacyDrafts: old?.legacyDrafts ?? EMPTY_LEGACY_DRAFTS,
          snapshot: old?.snapshot ?? EMPTY_SNAPSHOT,
        })
      )
    },
    [queryClient, pubkey]
  )

  const advancePublished = React.useCallback(
    (mutate: (prev: CatalogSnapshot) => CatalogSnapshot) => {
      advanceRead((prev) => ({ ...prev, snapshot: mutate(prev.snapshot) }))
    },
    [advanceRead]
  )

  /**
   * Adopt the freshly-read catalog into the draft — but NEVER over unsaved
   * work. A background refetch that silently threw away half an hour of edits
   * would be unforgivable, and these refetches happen on a timer the merchant
   * never asked for.
   */
  React.useEffect(() => {
    if (!pubkey || !catalogQuery.data) return
    const incoming = catalogQuery.data.snapshot
    setDraft((current) =>
      current === EMPTY_SNAPSHOT ||
      diffCatalog(publishedRef.current, current, pubkey).count === 0
        ? incoming
        : current
    )
  }, [catalogQuery.data, pubkey])

  // Only adopt the published NIP-65 list when there is no local edit yet.
  React.useEffect(() => {
    const list = catalogQuery.data?.relayList
    if (!list || readStoredRelays()) return
    // Deferred: a synchronous setState in an effect body cascades a render.
    const id = setTimeout(() => setNip65Relays(list), 0)
    return () => clearTimeout(id)
  }, [catalogQuery.data])

  const refresh = React.useCallback(async () => {
    await catalogQuery.refetch()
  }, [catalogQuery])

  /**
   * Warn before losing staged work.
   *
   * Only for the hard exits a router guard cannot see — tab close, reload,
   * external navigation.
   */
  React.useEffect(() => {
    if (changes.count === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [changes.count])

  /**
   * Pull the truth back from relays a few seconds after a write settles.
   *
   * Debounced hard: a burst of saves would otherwise trigger one full refetch
   * each, and the optimistic state is already correct in the meantime.
   */
  const reconcileTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReconcile = React.useCallback(() => {
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current)
    reconcileTimer.current = setTimeout(() => void refresh(), 4000)
  }, [refresh])

  React.useEffect(
    () => () => {
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current)
    },
    []
  )

  const markPending = React.useCallback((id: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // ── Draft mutations. None of these touch a relay. ───────────────────────

  const saveProduct = React.useCallback(
    (p: Product) => {
      if (!pubkey) return
      const withKey = { ...p, pubkey }
      setDraft((prev) => {
        const idx = prev.products.findIndex((x) => x.d === p.d)
        const products =
          idx === -1
            ? [...prev.products, withKey]
            : prev.products.map((x) => (x.d === p.d ? withKey : x))
        return { ...prev, products }
      })
    },
    [pubkey]
  )

  const saveProducts = React.useCallback(
    (list: Product[]) => {
      if (!pubkey || list.length === 0) return
      setDraft((prev) => {
        const byD = new Map(prev.products.map((x) => [x.d, x]))
        for (const p of list) byD.set(p.d, { ...p, pubkey })
        return { ...prev, products: [...byD.values()] }
      })
    },
    [pubkey]
  )

  const deleteProduct = React.useCallback((p: Product) => {
    setDraft((prev) => ({
      ...prev,
      products: prev.products.filter((x) => x.d !== p.d),
    }))
  }, [])

  const saveCategory = React.useCallback((c: Category) => {
    setDraft((prev) => {
      const idx = prev.categories.findIndex((x) => x.d === c.d)
      const categories = (
        idx === -1 ? [...prev.categories, c] : prev.categories.map((x) => (x.d === c.d ? c : x))
      ).sort(byOrderThenName)
      return { ...prev, categories }
    })
  }, [])

  const deleteCategory = React.useCallback(
    (c: Category, reassign: "orphan" | "delete") => {
      setDraft((prev) => {
        const members = prev.products.filter((p) => p.categories.includes(c.slug))
        const memberDs = new Set(members.map((p) => p.d))
        return {
          categories: prev.categories.filter((x) => x.d !== c.d),
          products:
            reassign === "delete"
              ? prev.products.filter((p) => !memberDs.has(p.d))
              : // Strip the slug: `t` is authoritative for membership, so it
                // must stop pointing at a category that no longer exists.
                prev.products.map((p) =>
                  memberDs.has(p.d)
                    ? { ...p, categories: p.categories.filter((s) => s !== c.slug) }
                    : p
                ),
        }
      })
    },
    []
  )

  const discardChanges = React.useCallback(() => {
    setDraft(publishedRef.current)
  }, [])

  // ── Publishing ──────────────────────────────────────────────────────────

  /**
   * Hand a template to the background queue.
   *
   * `advance` runs only when the event actually landed on at least one relay.
   * That is what moves an entity from `draft` into `published` and clears its
   * badge — so a partial failure leaves exactly the failed items still marked
   * as unsaved, which is the correct thing for the merchant to see.
   */
  const publish = React.useCallback(
    (
      template: EventTemplate,
      label: string,
      opts: { trackId?: string; advance?: () => void } = {}
    ) => {
      if (!signer) return
      if (opts.trackId) markPending(opts.trackId, true)

      enqueue({
        label,
        template,
        sign: (t) => signer.signEvent(t),
        relays: writeRelays(relayEntriesRef.current),
        onSettled: (report) => {
          if (opts.trackId) markPending(opts.trackId, false)
          if (report && report.ok.length > 0) opts.advance?.()
          scheduleReconcile()
        },
      })
    },
    [signer, enqueue, markPending, scheduleReconcile]
  )

  const saveChanges = React.useCallback(() => {
    if (!pubkey || !signer) return

    const before = publishedRef.current
    const current = draftRef.current
    const diff = diffCatalog(before, current, pubkey)
    if (diff.count === 0) return

    const slugToD = new Map(current.categories.map((c) => [c.slug, c.d]))

    // Upserts first, deletions last: a category delete strips slugs off its
    // members, and those member updates should land before the category
    // coordinate disappears.
    for (const [d, kind] of diff.products) {
      if (kind === "deleted") continue
      const p = current.products.find((x) => x.d === d)!
      const previous = before.products.find((x) => x.d === d)

      /**
       * `published_at` is the FIRST publish time and must survive every edit.
       *
       * A product authored or imported here carries 0 until its first event
       * lands, and the builder then writes `created_at` into the tag. If the
       * draft is left at 0, two things break: the relay copy comes back with
       * a real timestamp and the product reads as modified forever, and the
       * NEXT save rewrites `published_at` to a fresh time, quietly moving the
       * product's birthday. So resolve it here and remember it.
       */
      const resolved: Product = {
        ...p,
        publishedAt: p.publishedAt || previous?.publishedAt || 0,
      }
      const template = buildProductEvent(resolved, slugToD, previous?.updatedAt)
      const settled: Product = {
        ...resolved,
        publishedAt: resolved.publishedAt || template.created_at,
      }

      publish(template, p.title || "Producto", {
        trackId: d,
        advance: () => {
          advancePublished((prev) => ({
            ...prev,
            products: prev.products.some((x) => x.d === d)
              ? prev.products.map((x) => (x.d === d ? settled : x))
              : [...prev.products, settled],
          }))
          // Patch ONLY the timestamp, and only while it is still the
          // placeholder — the merchant may have edited this product while the
          // event was in flight, and overwriting the draft would lose that.
          setDraft((prev) => ({
            ...prev,
            products: prev.products.map((x) =>
              x.d === d && !x.publishedAt
                ? { ...x, publishedAt: settled.publishedAt }
                : x
            ),
          }))
        },
      })
    }

    for (const [d, kind] of diff.categories) {
      if (kind === "deleted") continue
      const c = current.categories.find((x) => x.d === d)!
      const previous = before.categories.find((x) => x.d === d)
      publish(buildCategoryEvent(c, pubkey, previous?.updatedAt), c.name || "Categoría", {
        trackId: d,
        advance: () =>
          advancePublished((prev) => ({
            ...prev,
            categories: (prev.categories.some((x) => x.d === d)
              ? prev.categories.map((x) => (x.d === d ? c : x))
              : [...prev.categories, c]
            ).sort(byOrderThenName),
          })),
      })
    }

    for (const [d, kind] of diff.products) {
      if (kind !== "deleted") continue
      const p = before.products.find((x) => x.d === d)!
      const t = nowSeconds()

      // ORDER MATTERS. NIP-09 deletes every version up to AND INCLUDING the
      // kind-5's created_at, so tombstone-then-delete would destroy the
      // tombstone too and leave the coordinate with no live event at all.
      // The queue is FIFO and serial, so enqueue order is publish order.
      publish(
        {
          kind: KINDS.DELETION,
          created_at: t,
          content: "Producto eliminado",
          tags: [
            ["a", coordinate(KINDS.PRODUCT, pubkey, p.d)],
            ["k", String(KINDS.PRODUCT)],
          ],
        },
        `Borrar ${p.title}`,
        {
          trackId: d,
          advance: () =>
            advancePublished((prev) => ({
              ...prev,
              products: prev.products.filter((x) => x.d !== d),
            })),
        }
      )

      // Tombstone strictly AFTER the cutoff, so it survives for relays and
      // clients that ignore kind 5: they must see a hidden product, never a
      // live one.
      publish(
        {
          kind: KINDS.PRODUCT_DRAFT,
          created_at: t + 1,
          content: "",
          tags: [
            ["d", p.d],
            ["title", p.title],
            ["deleted", ""],
            ["visibility", "hidden"],
            ["status", "sold"],
            ["alt", "Producto eliminado"],
          ],
        },
        `Lápida de ${p.title}`
      )
    }

    for (const [d, kind] of diff.categories) {
      if (kind !== "deleted") continue
      const c = before.categories.find((x) => x.d === d)!
      publish(
        {
          kind: KINDS.DELETION,
          created_at: nowSeconds(),
          content: "Categoría eliminada",
          tags: [
            ["a", coordinate(KINDS.CATEGORY, pubkey, c.d)],
            ["k", String(KINDS.CATEGORY)],
          ],
        },
        `Borrar ${c.name}`,
        {
          trackId: d,
          advance: () =>
            advancePublished((prev) => ({
              ...prev,
              categories: prev.categories.filter((x) => x.d !== d),
            })),
        }
      )
    }

  }, [pubkey, signer, publish, advancePublished])

  /**
   * One-time migration: the draft feature is gone, so whatever still lives at
   * 30403 gets the same treatment as a product deletion — kind 5 first, then
   * a tombstone strictly after the cutoff, for clients that ignore kind 5.
   * Runs from the /products banner; each swept draft leaves the read cache on
   * settle, so the banner counts down and disappears for good.
   */
  const sweepLegacyDrafts = React.useCallback(() => {
    if (!pubkey || !signer) return
    for (const ld of legacyDrafts) {
      const t = nowSeconds()
      publish(
        {
          kind: KINDS.DELETION,
          created_at: t,
          content: "Borrador eliminado",
          tags: [
            ["a", coordinate(KINDS.PRODUCT_DRAFT, pubkey, ld.d)],
            ["k", String(KINDS.PRODUCT_DRAFT)],
          ],
        },
        `Borrar borrador ${ld.title}`,
        {
          // Namespaced: in the dual-coordinate ghost case (comment above,
          // ~line 246) `ld.d` can equal a LIVE product's `d`. A bare `ld.d`
          // would land in the same `pending` set the board dims products by,
          // so sweeping the ghost draft would transiently dim the unrelated
          // live product.
          trackId: `legacy-draft:${ld.d}`,
          advance: () =>
            advanceRead((prev) => ({
              ...prev,
              legacyDrafts: prev.legacyDrafts.filter((x) => x.d !== ld.d),
            })),
        }
      )
      publish(
        {
          kind: KINDS.PRODUCT_DRAFT,
          created_at: t + 1,
          content: "",
          tags: [
            ["d", ld.d],
            ["title", ld.title],
            ["deleted", ""],
            ["visibility", "hidden"],
            ["status", "sold"],
            ["alt", "Producto eliminado"],
          ],
        },
        `Lápida de ${ld.title}`
      )
    }
  }, [pubkey, signer, legacyDrafts, publish, advanceRead])

  const publishAppData = React.useCallback(
    (d: string, ciphertext: string, label: string) => {
      if (!pubkey) return
      const previous = appData.find((e) => isOurWooConfig(e, pubkey, d))
      publish(
        buildAppDataEvent(d, ciphertext, pubkey, previous?.created_at),
        label
      )
    },
    [pubkey, publish, appData]
  )

  const publishRelayList = React.useCallback(() => {
    if (!pubkey) return
    const address = coordinate(KINDS.RELAY_LIST, pubkey, "")
    publish(
      buildRelayListEvent(relayEntriesRef.current, nextCreatedAt(address)),
      "Lista de relays (NIP-65)"
    )
  }, [pubkey, publish])

  const value = React.useMemo<CatalogContextValue>(
    () => ({
      loading,
      syncing,
      products: draft.products,
      categories: draft.categories,
      relayEntries,
      changes,
      saving,
      pending,
      refresh,
      saveProduct,
      saveProducts,
      deleteProduct,
      saveCategory,
      deleteCategory,
      saveChanges,
      discardChanges,
      setRelayEntries,
      publishRelayList,
      legacyDrafts,
      sweepLegacyDrafts,
      appData,
      publishAppData,
    }),
    [
      loading,
      draft,
      relayEntries,
      changes,
      saving,
      syncing,
      pending,
      refresh,
      saveProduct,
      saveProducts,
      deleteProduct,
      saveCategory,
      deleteCategory,
      saveChanges,
      discardChanges,
      setRelayEntries,
      publishRelayList,
      legacyDrafts,
      sweepLegacyDrafts,
      appData,
      publishAppData,
    ]
  )

  return (
    <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
  )
}

export function useCatalog(): CatalogContextValue {
  const ctx = React.useContext(CatalogContext)
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>")
  return ctx
}
