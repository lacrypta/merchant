import Link from "next/link"

import { LoginButton } from "@/components/auth/login-button"
import { Logo } from "@/components/brand/logo"

/** Public navbar — landing and storefront. The dashboard has its own shell. */
export function SiteNavbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-app items-center justify-between gap-4 px-4 md:px-8">
        <Link
          href="/"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Logo />
          <span className="sr-only">Merchant Manager — La Crypta</span>
        </Link>

        <LoginButton />
      </div>
    </header>
  )
}
