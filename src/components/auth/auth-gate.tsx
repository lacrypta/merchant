"use client"

import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { LoginDialog } from "@/components/auth/login-dialog"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/feedback/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Gates the whole administration area.
 *
 * Client-side by necessity: the session lives in localStorage and the signer
 * needs window.nostr, neither of which exist during SSR. This is an access
 * gate for a single-user tool, not a security boundary — every write is
 * ultimately authorised by the merchant's own signature, so an unauthenticated
 * visitor who bypassed this UI still could not publish anything.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { state } = useAuth()
  const [open, setOpen] = React.useState(false)

  // ONLY `booting` is a skeleton. `connecting` must keep rendering the login
  // UI, because that is when the LoginDialog is showing the nostrconnect QR
  // the user has to scan — swapping to a skeleton here unmounts the dialog
  // and hides the code at exactly the wrong moment.
  if (state.status === "booting") {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    )
  }

  if (state.status === "ready") {
    return <>{children}</>
  }

  return (
    <>
      <EmptyState
        title="Ingresá para administrar tu catálogo"
        description="El panel es privado: sólo vos podés crear, editar y publicar productos con tu clave."
        action={<Button onClick={() => setOpen(true)}>Ingresar con Nostr</Button>}
      />
      <LoginDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
