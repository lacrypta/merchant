import Link from "next/link"

import { Logo } from "@/components/brand/logo"
import { AppSidebar } from "@/components/shell/app-sidebar"
import { MobileTabBar } from "@/components/shell/mobile-tab-bar"
import { LiveRegions } from "@/components/shell/live-regions"

/**
 * Dashboard shell.
 *
 * The sidebar/tab-bar switch is pure CSS (`hidden lg:flex` / `lg:hidden`),
 * NOT useMediaQuery — a JS breakpoint would flash the wrong layout on first
 * paint. useMediaQuery is reserved for cases where the component identity
 * must change (see ResponsiveDialog).
 */
export function AppShell({
  children,
  topbar,
}: {
  children: React.ReactNode
  topbar?: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* First focusable node on the page. */}
      <a
        href="#main"
        className="sr-only rounded-full bg-primary px-5 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
      >
        Saltar al contenido
      </a>

      <AppSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur md:px-6">
          <Link href="/products" className="lg:hidden">
            <Logo showWordmark={false} />
            <span className="sr-only">Merchant Manager</span>
          </Link>
          {topbar}
        </header>

        <main
          id="main"
          className="mx-auto w-full max-w-app flex-1 px-4 py-6 pb-24 md:px-6 lg:pb-6"
        >
          {children}
        </main>
      </div>

      <MobileTabBar />
      <LiveRegions />
    </div>
  )
}
