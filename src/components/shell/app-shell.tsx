import { AppSidebar } from "@/components/shell/app-sidebar"
import { LiveRegions } from "@/components/shell/live-regions"
import { MobileTabBar } from "@/components/shell/mobile-tab-bar"
import { SiteFooter } from "@/components/shell/site-footer"
import { SiteNavbar } from "@/components/shell/site-navbar"

/**
 * Dashboard shell.
 *
 * Uses the SAME <SiteNavbar> as the landing and the public storefront, so the
 * brand mark and the account control never shift position when you log in.
 * The sidebar sits BELOW that navbar rather than beside it, which is what
 * lets the header span the full width in every context.
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
  /** Screen-owned context (relay status, publish queue) shown in the navbar. */
  topbar?: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* First focusable node on the page. */}
      <a
        href="#main"
        className="sr-only rounded-full bg-primary px-5 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
      >
        Saltar al contenido
      </a>

      <SiteNavbar extra={topbar} />

      <div className="mx-auto flex w-full max-w-app flex-1">
        <AppSidebar />

        <main
          id="main"
          className="min-w-0 flex-1 px-4 py-6 pb-24 md:px-6 lg:pb-6"
        >
          {children}
        </main>
      </div>

      {/* `pb-20` on mobile clears the tab bar fixed over the end of the page. */}
      <SiteFooter className="pb-20 lg:pb-0" />

      <MobileTabBar />
      <LiveRegions />
    </div>
  )
}
