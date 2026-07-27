"use client"

import {
  BadgeCheck,
  Copy,
  LayoutDashboard,
  LogIn,
  LogOut,
  Store,
  TriangleAlert,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import * as React from "react"

import { shortNpub, useAuth } from "@/components/auth/auth-provider"
import { LoginDialog } from "@/components/auth/login-dialog"
import { NostrAvatar } from "@/components/nostr/nostr-avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useNostrProfile } from "@/hooks/use-nostr-profile"
import { profileLabel } from "@/lib/domain/profile"

/**
 * The single account control for the whole app.
 *
 * Handles every auth state so there is exactly ONE navbar component: the
 * landing, the public storefront and the dashboard all render the same
 * header, and only this control changes shape.
 */
export function AccountMenu() {
  const { state, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const { profile, nip05State } = useNostrProfile(pubkey)
  const [copied, setCopied] = React.useState(false)
  const [loginOpen, setLoginOpen] = React.useState(false)

  /**
   * Send the merchant to the panel after a login STARTED HERE.
   *
   * The dialog cannot do this itself: it unmounts as soon as auth flips to
   * `ready`. The ref also keeps a restored session from yanking someone off
   * the public storefront on page load.
   */
  const startedLogin = React.useRef(false)
  React.useEffect(() => {
    if (state.status === "ready" && startedLogin.current) {
      startedLogin.current = false
      router.push("/products")
    }
  }, [state.status, router])

  // Rendered on the server and on the first client paint, so the hydrated
  // tree matches — swapping "Ingresar" for the merchant chip would flash.
  if (state.status === "booting") {
    return <Skeleton className="h-11 w-32 rounded-full" />
  }

  if (state.status !== "ready") {
    return (
      <>
        <Button
          onClick={() => {
            startedLogin.current = true
            setLoginOpen(true)
          }}
        >
          <LogIn className="size-4" aria-hidden />
          Ingresar con Nostr
        </Button>
        <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      </>
    )
  }

  const label = profileLabel(profile, state.npub)
  // Only ever present the address as trustworthy once the domain maps it back
  // to this pubkey. A claimed-but-unverified nip05 shows without a check.
  const verified = nip05State === "verified"
  const secondary = verified ? profile!.nip05! : shortNpub(state.npub)
  const insideDashboard =
    pathname.startsWith("/products") || pathname.startsWith("/settings")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 gap-2 px-2 pr-3"
          aria-label={`Cuenta de ${label}`}
        >
          <NostrAvatar pubkey={pubkey} npub={state.npub} size={28} />
          <span className="hidden min-w-0 flex-col items-start leading-tight sm:flex">
            <span className="max-w-[14ch] truncate text-sm font-semibold">
              {label}
            </span>
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              {verified ? (
                <BadgeCheck className="size-3 text-primary" aria-hidden />
              ) : null}
              <span className="max-w-[16ch] truncate">{secondary}</span>
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72 [&_[data-slot=dropdown-menu-item]]:text-sm">
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-3">
            <NostrAvatar pubkey={pubkey} npub={state.npub} size={44} />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{label}</p>
              <p className="text-sm text-muted-foreground">
                {state.method === "nip07" ? "Extensión" : "Firmante remoto"}
              </p>
            </div>
          </div>
        </DropdownMenuLabel>

        {profile?.nip05 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <p className="mb-1 text-sm text-muted-foreground">NIP-05</p>
              <p className="flex items-start gap-1.5 text-base break-all">
                {verified ? (
                  <BadgeCheck
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                ) : (
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-warning"
                    aria-hidden
                  />
                )}
                <span>{profile.nip05}</span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {nip05State === "verified"
                  ? "El dominio confirma esta clave."
                  : nip05State === "checking"
                    ? "Verificando…"
                    : nip05State === "mismatch"
                      ? "El dominio apunta a otra clave."
                      : "No pudimos contactar al dominio."}
              </p>
            </div>
          </>
        ) : null}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            void navigator.clipboard.writeText(state.npub)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
        >
          <Copy className="size-4" aria-hidden />
          {copied ? "Copiado" : "Copiar npub"}
        </DropdownMenuItem>

        {/* Only offer the dashboard link from outside it. */}
        {!insideDashboard ? (
          <DropdownMenuItem asChild>
            <Link href="/products">
              <LayoutDashboard className="size-4" aria-hidden />
              Ir al panel
            </Link>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem asChild>
          <Link href={`/s/${state.npub}`}>
            <Store className="size-4" aria-hidden />
            Ver mi tienda
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} className="text-danger">
          <LogOut className="size-4" aria-hidden />
          Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
