"use client"

import { Pencil } from "lucide-react"
import Link from "next/link"

import { useAuth } from "@/components/auth/auth-provider"
import { DASHBOARD_HOME } from "@/components/shell/nav-items"
import { Button } from "@/components/ui/button"

/**
 * A way back to the editor, shown only to the merchant looking at their own
 * shop.
 *
 * The public storefront is the page a merchant checks constantly — it is how
 * they see what customers see — and until now the only way back to the editor
 * was the account menu. This is the shortcut, and it appears for nobody else.
 *
 * The comparison is on the PUBKEY, never the handle: the same shop is
 * reachable as an npub, an nprofile or any NIP-05 that points at it.
 */
export function EditStoreButton({ merchantPubkey }: { merchantPubkey: string }) {
  const { state } = useAuth()

  if (state.status !== "ready" || state.pubkey !== merchantPubkey) return null

  return (
    <Button variant="outline" size="sm" className="enter-pop" asChild>
      <Link href={DASHBOARD_HOME}>
        <Pencil className="size-4" aria-hidden />
        Editar tienda
      </Link>
    </Button>
  )
}
