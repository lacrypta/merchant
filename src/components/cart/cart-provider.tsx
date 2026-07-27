"use client"

import * as React from "react"

import {
  addToCart,
  cartCount,
  cartKey,
  cartQuote,
  emptyCart,
  parseCart,
  qtyOf,
  reconcile,
  removeLine,
  setQty,
  type Cart,
  type CartItem,
  type CatalogIndex,
  type LineIssue,
} from "@/lib/domain/cart"
import type { Quote, SatPriceTable } from "@/lib/domain/rates"
import { useRates } from "@/hooks/use-rates"
import type { MerchantSummary } from "@/lib/server/storefront"

/**
 * The shopping cart for ONE merchant's storefront.
 *
 * Mounted by src/app/s/[handle]/layout.tsx rather than the global providers,
 * for a concrete reason: the global provider has no `params` and therefore no
 * pubkey, so it would have to re-resolve the handle client-side on every
 * storefront load just to know which localStorage key to read. The layout
 * gets the resolved merchant for free, and React remounts it when the
 * `[handle]` segment changes — which is exactly the isolation two different
 * shops need.
 *
 * Z-INDEX LADDER (documented here because three components share it):
 *   z-30  reserved for the dashboard's MobileTabBar — never on a storefront
 *   z-40  SiteNavbar (sticky top) AND MobileCartBar (fixed bottom)
 *   z-50  Radix/vaul overlay + content
 */
interface CartContextValue {
  merchant: MerchantSummary
  catalog: CatalogIndex
  cart: Cart
  /**
   * False on the server and on the first client render.
   *
   * The count comes from localStorage, which does not exist during SSR, so
   * every consumer must render `hydrated ? count : 0` or React will complain
   * about a hydration mismatch on the very first paint. Naming the flag —
   * rather than sprinkling ad-hoc effects — is what keeps that consistent.
   */
  hydrated: boolean
  count: number
  issues: LineIssue[]
  /** null until the first rate snapshot lands. */
  rates: SatPriceTable | null
  ratesAsOf: number | null
  ratesStale: boolean
  refreshRates: () => void
  quote: Quote | null
  displayCurrency: string
  setDisplayCurrency: (c: string) => void
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  add: (item: CartItem, delta?: number) => void
  setLineQty: (d: string, qty: number) => void
  remove: (d: string) => void
  clear: () => void
  qtyOf: (d: string) => number
}

const CartContext = React.createContext<CartContextValue | null>(null)

const DISPLAY_CURRENCY_KEY = "mm:display-currency"

function readDisplayCurrency(): string | null {
  try {
    return window.localStorage.getItem(DISPLAY_CURRENCY_KEY)
  } catch {
    return null
  }
}

export function CartProvider({
  merchant,
  catalog,
  children,
}: {
  merchant: MerchantSummary
  catalog: CatalogIndex
  children: React.ReactNode
}) {
  const [cart, setCart] = React.useState<Cart>(() => emptyCart(0))
  const [hydrated, setHydrated] = React.useState(false)
  const [issues, setIssues] = React.useState<LineIssue[]>([])
  const [panelOpen, setPanelOpen] = React.useState(false)
  const [displayCurrency, setDisplayCurrencyState] = React.useState("ARS")

  const { rates, refresh: refreshRates } = useRates()
  const key = cartKey(merchant.pubkey)

  // Restore, then immediately reconcile against the catalog we just rendered.
  // Doing both in one effect means the merchant's price changes are noticed
  // before the customer sees a total.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const now = Date.now()
      let restored: Cart
      try {
        restored = parseCart(window.localStorage.getItem(key), now) ?? emptyCart(now)
      } catch {
        restored = emptyCart(now)
      }
      const r = reconcile(restored, catalog, now)
      if (cancelled) return
      setCart(r.cart)
      setIssues(r.issues)
      setDisplayCurrencyState(readDisplayCurrency() ?? defaultCurrency(r.cart))
      setHydrated(true)
    })()
    return () => {
      cancelled = true
    }
  }, [key, catalog])

  // Persist after every change, but never before hydration — writing the
  // empty initial cart would wipe a real one on first paint.
  React.useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(key, JSON.stringify(cart))
    } catch {
      /* private mode */
    }
  }, [cart, key, hydrated])

  // Two tabs on the same shop share one cart.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return
      const next = parseCart(e.newValue, Date.now())
      if (next) setCart(next)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [key])

  const setDisplayCurrency = React.useCallback((c: string) => {
    setDisplayCurrencyState(c)
    try {
      // Global, not per-merchant: it is a preference of whoever is LOOKING,
      // and it should not flip between two shops in the same session.
      window.localStorage.setItem(DISPLAY_CURRENCY_KEY, c)
    } catch {
      /* private mode */
    }
  }, [])

  const add = React.useCallback((item: CartItem, delta = 1) => {
    setCart((prev) => addToCart(prev, item, Date.now(), delta))
  }, [])

  const setLineQty = React.useCallback((d: string, qty: number) => {
    setCart((prev) => setQty(prev, d, qty, Date.now()))
  }, [])

  const remove = React.useCallback((d: string) => {
    setCart((prev) => removeLine(prev, d, Date.now()))
  }, [])

  const clear = React.useCallback(() => {
    setCart(emptyCart(Date.now()))
    setIssues([])
  }, [])

  const quote = React.useMemo(
    () => (rates ? cartQuote(cart, rates.satPrice) : null),
    [cart, rates]
  )

  const value = React.useMemo<CartContextValue>(
    () => ({
      merchant,
      catalog,
      cart,
      hydrated,
      count: hydrated ? cartCount(cart) : 0,
      issues,
      rates: rates?.satPrice ?? null,
      ratesAsOf: rates?.asOf ?? null,
      ratesStale: rates?.stale ?? false,
      refreshRates,
      quote,
      displayCurrency,
      setDisplayCurrency,
      panelOpen,
      setPanelOpen,
      add,
      setLineQty,
      remove,
      clear,
      qtyOf: (d: string) => (hydrated ? qtyOf(cart, d) : 0),
    }),
    [
      merchant,
      catalog,
      cart,
      hydrated,
      issues,
      rates,
      refreshRates,
      quote,
      displayCurrency,
      setDisplayCurrency,
      panelOpen,
      add,
      setLineQty,
      remove,
      clear,
    ]
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

/** Whatever most of the cart is already priced in; pesos otherwise. */
function defaultCurrency(cart: Cart): string {
  const tally = new Map<string, number>()
  for (const l of cart.lines) {
    tally.set(l.currency, (tally.get(l.currency) ?? 0) + l.qty)
  }
  let best = "ARS"
  let bestN = 0
  for (const [c, n] of tally) {
    if (n > bestN) {
      best = c
      bestN = n
    }
  }
  return best
}

export function useCart(): CartContextValue {
  const ctx = React.useContext(CartContext)
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>")
  return ctx
}
