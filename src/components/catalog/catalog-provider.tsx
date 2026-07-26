"use client"

import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { usePublishMonitor } from "@/components/publish/publish-monitor"
import {
  buildCategoryEvent,
  parseCategoryEvent,
  type Category,
} from "@/lib/domain/category"
import { KINDS } from "@/lib/domain/kinds"
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
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { coordinate, coordinateOf } from "@/lib/nostr/tags"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

interface CatalogContextValue {
  loading: boolean
  products: Product[]
  categories: Category[]
  relayEntries: RelayEntry[]
  /** d-tags with an in-flight write, for the dimmed row treatment. */
  pending: Set<string>
  refresh: () => Promise<void>
  saveProduct: (p: Product) => void
  deleteProduct: (p: Product) => void
  saveCategory: (c: Category) => void
  deleteCategory: (c: Category, reassign: "orphan" | "delete") => void
  setRelayEntries: (entries: RelayEntry[]) => void
  publishRelayList: () => void
}

const CatalogContext = React.createContext<CatalogContextValue | null>(null)

const RELAYS_KEY = "mm:relays"

function readStoredRelays(): RelayEntry[] | null {
  try {
    const raw = window.localStorage.getItem(RELAYS_KEY)
    return raw ? (JSON.parse(raw) as RelayEntry[]) : null
  } catch {
    return null
  }
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

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const { state, signer } = useAuth()
  const { enqueue } = usePublishMonitor()
  const pubkey = state.status === "ready" ? state.pubkey : null

  const [loading, setLoading] = React.useState(true)
  const [products, setProducts] = React.useState<Product[]>([])
  const [categories, setCategories] = React.useState<Category[]>([])
  const [relayEntries, setRelayEntriesState] = React.useState<RelayEntry[]>(() =>
    mergeWithDefaults([], DEFAULT_RELAYS)
  )
  const [pending, setPending] = React.useState<Set<string>>(new Set())

  // Mirrored into refs so async queue callbacks read CURRENT values without
  // being re-created on every edit. Written in effects, never during render.
  const relayEntriesRef = React.useRef(relayEntries)
  const productsRef = React.useRef(products)
  const categoriesRef = React.useRef(categories)
  React.useEffect(() => {
    relayEntriesRef.current = relayEntries
  }, [relayEntries])
  React.useEffect(() => {
    productsRef.current = products
  }, [products])
  React.useEffect(() => {
    categoriesRef.current = categories
  }, [categories])

  const setRelayEntries = React.useCallback((entries: RelayEntry[]) => {
    setRelayEntriesState(entries)
    try {
      window.localStorage.setItem(RELAYS_KEY, JSON.stringify(entries))
    } catch {
      /* private mode */
    }
  }, [])

  const load = React.useCallback(async () => {
    if (!pubkey) {
      setProducts([])
      setCategories([])
      setLoading(false)
      return
    }

    // Locally-edited relay list wins over both NIP-65 and the defaults, so a
    // merchant who just removed a relay doesn't see it reappear on refresh.
    const stored = readStoredRelays()
    const baseEntries = stored ?? relayEntriesRef.current
    const readUrls = dedupeRelays([
      ...baseEntries.filter((e) => e.read).map((e) => e.url),
      ...DEFAULT_RELAYS,
    ])

    const events = await queryEvents(
      [
        {
          kinds: [KINDS.PRODUCT, KINDS.PRODUCT_DRAFT, KINDS.CATEGORY],
          authors: [pubkey],
        },
        { kinds: [KINDS.DELETION], authors: [pubkey] },
        { kinds: [KINDS.RELAY_LIST], authors: [pubkey] },
      ],
      readUrls
    )

    const deletions = buildDeletionIndex(events)
    const live = events.filter((e) => {
      const coord = coordinateOf(e)
      return !coord || (deletions.get(coord) ?? -1) < e.created_at
    })

    const addressable = latestByAddress(live.filter((e) => e.kind >= 30000))

    const nextProducts: Product[] = []
    const nextCategories: Category[] = []
    for (const e of addressable) {
      if (e.kind === KINDS.PRODUCT || e.kind === KINDS.PRODUCT_DRAFT) {
        const r = parseProductEvent(e)
        if (r.ok) nextProducts.push(r.value)
      } else if (e.kind === KINDS.CATEGORY) {
        const r = parseCategoryEvent(e, pubkey)
        if (r.ok) nextCategories.push(r.value)
      }
    }

    nextCategories.sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name, "es-AR")
    )

    setProducts(nextProducts)
    setCategories(nextCategories)

    // Only adopt the published NIP-65 list when there is no local edit yet.
    if (!stored) {
      const relayEvent = live
        .filter((e) => e.kind === KINDS.RELAY_LIST)
        .sort((a, b) => b.created_at - a.created_at)[0]
      if (relayEvent) {
        setRelayEntriesState(
          mergeWithDefaults(parseRelayListEvent(relayEvent), DEFAULT_RELAYS)
        )
      }
    } else {
      setRelayEntriesState(stored)
    }

    setLoading(false)
  }, [pubkey])

  React.useEffect(() => {
    // Deferred: load() flips `loading` synchronously, and a sync setState in
    // an effect body causes a cascading render.
    const id = setTimeout(() => void load(), 0)
    return () => clearTimeout(id)
  }, [load])

  /**
   * Reconcile against relays after writes settle.
   *
   * Debounced hard: a burst of edits would otherwise trigger one full catalog
   * refetch each, and the optimistic state is already correct in the meantime.
   */
  const reconcileTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReconcile = React.useCallback(() => {
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current)
    reconcileTimer.current = setTimeout(() => void load(), 4000)
  }, [load])

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

  /**
   * Hand a template to the background queue.
   *
   * Returns immediately — callers have already applied their optimistic state
   * change, so the merchant can keep working while this drains.
   */
  const publish = React.useCallback(
    (template: EventTemplate, label: string, trackId?: string) => {
      if (!signer) return
      if (trackId) markPending(trackId, true)

      enqueue({
        label,
        template,
        sign: (t) => signer.signEvent(t),
        relays: writeRelays(relayEntriesRef.current),
        onSettled: () => {
          if (trackId) markPending(trackId, false)
          scheduleReconcile()
        },
      })
    },
    [signer, enqueue, markPending, scheduleReconcile]
  )

  const saveProduct = React.useCallback(
    (p: Product) => {
      if (!pubkey) return
      const previous = productsRef.current.find((x) => x.d === p.d)
      const withKey = { ...p, pubkey }

      // Optimistic upsert BEFORE signing, so the list and any navigation
      // reflect the change instantly.
      setProducts((prev) => {
        const idx = prev.findIndex((x) => x.d === p.d)
        if (idx === -1) return [...prev, withKey]
        const next = [...prev]
        next[idx] = withKey
        return next
      })

      const slugToD = new Map(categoriesRef.current.map((c) => [c.slug, c.d]))
      publish(
        buildProductEvent(withKey, slugToD, previous?.updatedAt),
        p.title || "Producto",
        p.d
      )
    },
    [pubkey, publish]
  )

  const deleteProduct = React.useCallback(
    (p: Product) => {
      if (!pubkey) return

      setProducts((prev) => prev.filter((x) => x.d !== p.d))

      const kind =
        p.lifecycle === "published" ? KINDS.PRODUCT : KINDS.PRODUCT_DRAFT
      const coord = coordinate(kind, pubkey, p.d)
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
            ["a", coord],
            ["k", String(kind)],
          ],
        },
        `Borrar ${p.title}`,
        p.d
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
    },
    [pubkey, publish]
  )

  const saveCategory = React.useCallback(
    (c: Category) => {
      if (!pubkey) return
      const previous = categoriesRef.current.find((x) => x.d === c.d)

      setCategories((prev) => {
        const idx = prev.findIndex((x) => x.d === c.d)
        const next = idx === -1 ? [...prev, c] : prev.map((x) => (x.d === c.d ? c : x))
        return next.sort(
          (a, b) => a.order - b.order || a.name.localeCompare(b.name, "es-AR")
        )
      })

      publish(
        buildCategoryEvent(c, pubkey, previous?.updatedAt),
        c.name || "Categoría",
        c.d
      )
    },
    [pubkey, publish]
  )

  const deleteCategory = React.useCallback(
    (c: Category, reassign: "orphan" | "delete") => {
      if (!pubkey) return

      const members = productsRef.current.filter((p) =>
        p.categories.includes(c.slug)
      )

      setCategories((prev) => prev.filter((x) => x.d !== c.d))

      if (reassign === "delete") {
        for (const p of members) deleteProduct(p)
      } else {
        // Strip this slug and republish each member, so `t` — which is
        // authoritative for membership — stops pointing at a category that no
        // longer exists.
        const slugToD = new Map(categoriesRef.current.map((x) => [x.slug, x.d]))
        for (const p of members) {
          const next = {
            ...p,
            categories: p.categories.filter((s) => s !== c.slug),
          }
          setProducts((prev) => prev.map((x) => (x.d === p.d ? next : x)))
          publish(
            buildProductEvent({ ...next, pubkey }, slugToD, p.updatedAt),
            `Quitar categoría de ${p.title}`,
            p.d
          )
        }
      }

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
        c.d
      )
    },
    [pubkey, publish, deleteProduct]
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
      products,
      categories,
      relayEntries,
      pending,
      refresh: load,
      saveProduct,
      deleteProduct,
      saveCategory,
      deleteCategory,
      setRelayEntries,
      publishRelayList,
    }),
    [
      loading,
      products,
      categories,
      relayEntries,
      pending,
      load,
      saveProduct,
      deleteProduct,
      saveCategory,
      deleteCategory,
      setRelayEntries,
      publishRelayList,
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
