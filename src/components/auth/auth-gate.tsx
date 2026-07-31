"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { LoginDialog } from "@/components/auth/login-dialog"
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
 *
 * Landing on /admin signed out puts the login dialog up immediately, and
 * dismissing it leaves for the landing page. Nobody arrives at a URL under
 * /admin wanting to look at a locked door: they either sign in or they are in
 * the wrong place, and those are exactly the two exits offered.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { state } = useAuth()
  const router = useRouter()

  // ONLY `booting` is a skeleton. `connecting` must keep rendering the login
  // UI, because that is when the LoginDialog is showing the nostrconnect QR
  // the user has to scan — swapping to a skeleton here unmounts the dialog
  // and hides the code at exactly the wrong moment.
  //
  // It is also why the dialog must not open until this state has passed: a
  // merchant whose session is about to restore would get a modal flashed at
  // them for the length of one round trip.
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
      {/*
        The panel behind the modal, and the only thing left on screen for the
        instant between dismissing it and the navigation landing. No button:
        the dialog is already open, and closing it is how you leave.
      */}
      <EmptyState
        title="Ingresá para administrar tu catálogo"
        description="El panel es privado: sólo vos podés crear, editar y publicar productos con tu clave."
      />
      <LoginDialog
        /**
         * Open, always — derived from the branch rather than stored. Reaching
         * here means not signed in, and seeding a `useState(true)` would be
         * state that can only ever hold one value, while opening it from an
         * effect is the synchronous setState the lint rule bans.
         *
         * A successful login does not close this: auth flips to `ready`, the
         * branch above wins, and the whole subtree unmounts without
         * onOpenChange ever firing. So closing really does mean "I am leaving".
         */
        open
        onOpenChange={(next) => {
          // `replace`, not `push`: a door they could not open has no business
          // in the history stack, where Back would walk them into it again.
          if (!next) router.replace("/")
        }}
      />
    </>
  )
}
