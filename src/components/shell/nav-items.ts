import {
  ClipboardList,
  Package,
  Settings,
  TicketPercent,
  type LucideIcon,
} from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /**
   * Prefix that marks this item active, when it differs from `href`.
   *
   * Ajustes points straight at a sub-page: `/settings` is a Server Component
   * that calls `redirect()`, and a redirect is a FULL page load — clicking the
   * sidebar reloaded the whole app and, on a NIP-07 session, dropped it.
   */
  match?: string
}

/**
 * Single source of truth for both the sidebar and the mobile tab bar.
 *
 * There is no separate Categorías entry: categories are sections of the
 * catalog board, managed in place on /products.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/products", label: "Catálogo", icon: Package },
  { href: "/orders", label: "Órdenes", icon: ClipboardList },
  { href: "/coupons", label: "Cupones", icon: TicketPercent },
  { href: "/settings/relays", label: "Ajustes", icon: Settings, match: "/settings" },
] as const

/** Where "Ir al panel" lands: the first thing in the nav. */
export const DASHBOARD_HOME = NAV_ITEMS[0]!.href

/**
 * Is this path already inside the panel?
 *
 * Derived from NAV_ITEMS rather than a hardcoded list of prefixes, which is how
 * the previous version came to miss /orders and /coupons: every new section had
 * to remember to update a second place. Now adding a nav item is enough.
 */
export function isDashboardPath(pathname: string): boolean {
  return NAV_ITEMS.some((item) => {
    const base = item.match ?? item.href
    return pathname === base || pathname.startsWith(`${base}/`)
  })
}
