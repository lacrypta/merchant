import { ClipboardList, Package, Settings, type LucideIcon } from "lucide-react"

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
  { href: "/settings/relays", label: "Ajustes", icon: Settings, match: "/settings" },
] as const
