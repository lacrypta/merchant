import { ClipboardList, Package, Settings, type LucideIcon } from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
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
  { href: "/settings", label: "Ajustes", icon: Settings },
] as const
