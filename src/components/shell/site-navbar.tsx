import Link from "next/link"

import { AccountMenu } from "@/components/auth/account-menu"
import { Logo } from "@/components/brand/logo"
import { SyncBadge } from "@/components/feedback/sync-badge"
import { RelayLogButton } from "@/components/nostr/relay-log-button"

/**
 * THE navbar. One component for every page — landing, public storefront and
 * the dashboard all render this exact header, so the brand mark never shifts
 * position when you log in.
 *
 * Only <AccountMenu> changes shape between states; the shell around it does
 * not. `extra` is for context the current screen owns (relay status, publish
 * queue), rendered between the logo and the account control.
 */
export function SiteNavbar({ extra }: { extra?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-app items-center gap-4 px-4 md:px-8">
        <Link
          href="/"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Logo />
          <span className="sr-only">Merchant Manager — La Crypta</span>
        </Link>

        {/* Beside the brand rather than in the busy right-hand cluster: it is
            ambient status about the whole page, not an action, and it must not
            shove the cart and account controls sideways when it appears. */}
        <SyncBadge className="hidden sm:inline-flex" />

        <div className="ml-auto flex items-center gap-2">
          {extra}
          <RelayLogButton />
          <AccountMenu />
        </div>
      </div>
    </header>
  )
}
