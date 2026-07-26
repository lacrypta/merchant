"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"
import { NAV_ITEMS } from "@/components/shell/nav-items"

/**
 * Bottom nav below `lg`. `safe-b` clears the iOS home indicator; each target
 * is 56px tall, comfortably over the 44px WCAG 2.5.8 floor.
 */
export function MobileTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Navegación inferior"
      className="safe-b fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-border bg-background/95 backdrop-blur lg:hidden"
    >
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              active ? "text-primary" : "text-muted-foreground"
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
