"use client"

import { LayoutDashboard, Store } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import { DASHBOARD_HOME, isDashboardPath } from "@/components/shell/nav-items"

/**
 * The way to the other side, for a merchant who is signed in.
 *
 * One slot, two directions: from the landing or their own storefront it offers
 * the panel; from inside the panel it offers the storefront. Whichever side you
 * are on, the button is the one you cannot already see — a "Ver mi tienda" on
 * the storefront would be a button that does nothing.
 *
 * It lives in the navbar rather than the account dropdown because nothing about
 * an avatar says "your shop is in here": that was two clicks and a guess.
 *
 * Hidden while auth is still booting, so the navbar does not shift once the
 * session resolves.
 */
export function SwitchViewButton() {
  const { state } = useAuth()
  const pathname = usePathname()

  if (state.status !== "ready") return null

  const inside = isDashboardPath(pathname)
  const href = inside ? `/s/${state.npub}` : DASHBOARD_HOME
  const label = inside ? "Ver mi tienda" : "Ir al panel"
  const Icon = inside ? Store : LayoutDashboard

  return (
    <Button variant="outline" asChild>
      <Link href={href}>
        <Icon className="size-4" aria-hidden />
        {/* The icon carries it on a phone: the navbar there is already the
            logo, the relay chip and the account control. */}
        <span className="hidden sm:inline">{label}</span>
        <span className="sr-only sm:hidden">{label}</span>
      </Link>
    </Button>
  )
}
