"use client"

import { LayoutDashboard, Store } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { NostrAvatar } from "@/components/nostr/nostr-avatar"
import { DASHBOARD_HOME } from "@/components/shell/nav-items"
import { Button } from "@/components/ui/button"
import { useNostrProfile } from "@/hooks/use-nostr-profile"
import { profileLabel } from "@/lib/domain/profile"

/**
 * "Go to my store", for someone already signed in.
 *
 * The landing sells the idea and offers a search box, which is exactly wrong
 * for the person who already has a catalog here — they arrive at their own
 * home page and have to remember their npub to see their own shop. This is
 * the shortcut.
 *
 * Renders nothing while auth is booting rather than a placeholder: the
 * session is restored from localStorage, so a logged-out visitor would see a
 * button flash and vanish.
 */
export function MyStoreCta() {
  const { state } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const { profile } = useNostrProfile(pubkey)

  if (state.status !== "ready") return null

  const label = profileLabel(profile, state.npub)

  return (
    <div className="enter-pop mt-10 w-full max-w-[680px] rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:text-left">
        <NostrAvatar pubkey={pubkey} npub={state.npub} size={48} />

        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold">{label}</p>
          <p className="text-sm text-muted-foreground">
            Tu tienda pública, lista para compartir.
          </p>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
          <Button asChild>
            <Link href={`/s/${state.npub}`}>
              <Store className="size-4" aria-hidden />
              Ver mi tienda
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={DASHBOARD_HOME}>
              <LayoutDashboard className="size-4" aria-hidden />
              Mi catálogo
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
