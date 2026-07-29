"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { NAV_ITEMS } from "@/components/shell/nav-items"
import { cn } from "@/lib/utils"

/**
 * Desktop navigation.
 *
 * Carries no logo: the shared <SiteNavbar> above owns the brand mark in every
 * context, so repeating it here would show it twice on desktop. `top-16`
 * parks the sticky column right under that navbar.
 */
export function AppSidebar() {
  const pathname = usePathname()

  return (
    <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[240px] shrink-0 flex-col border-r border-border py-4 pl-4 lg:flex">
      <nav className="flex-1 space-y-1 pr-4" aria-label="Secciones">
        {NAV_ITEMS.map(({ href, label, icon: Icon, match }) => {
          const base = match ?? href
          const active = pathname === base || pathname.startsWith(`${base}/`)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-11 items-center gap-3 rounded-full px-4 text-sm font-semibold transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
