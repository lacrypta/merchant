"use client"

import * as React from "react"
import Link from "next/link"
import { LogIn } from "lucide-react"

import { useAuth, shortNpub } from "@/components/auth/auth-provider"
import { LoginDialog } from "@/components/auth/login-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Navbar auth control.
 *
 * Renders a Skeleton while `booting` so the server HTML and the first client
 * render agree — showing "Ingresar" during SSR and then swapping to the
 * merchant chip would be a visible hydration flash.
 */
export function LoginButton() {
  const { state } = useAuth()
  const [open, setOpen] = React.useState(false)

  if (state.status === "booting") {
    return <Skeleton className="h-12 w-36 rounded-full" />
  }

  if (state.status === "ready") {
    return (
      <Button asChild variant="secondary">
        <Link href="/products">
          <span className="hidden sm:inline">Ir al panel</span>
          <span className="numeric text-xs text-muted-foreground sm:ml-1">
            {shortNpub(state.npub)}
          </span>
        </Link>
      </Button>
    )
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <LogIn className="size-4" aria-hidden />
        Ingresar con Nostr
      </Button>
      <LoginDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
