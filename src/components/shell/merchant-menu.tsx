"use client"

import { BadgeCheck, Copy, LogOut, Store, TriangleAlert } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { shortNpub, useAuth } from "@/components/auth/auth-provider"
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
import { TickerChip } from "@/components/ui/ticker-chip"
import { useNostrProfile } from "@/hooks/use-nostr-profile"
import { profileLabel } from "@/lib/domain/profile"

export function MerchantMenu() {
  const { state, logout } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const { profile, nip05State } = useNostrProfile(pubkey)
  const [copied, setCopied] = React.useState(false)

  if (state.status === "booting") {
    return (
      <div className="ml-auto flex items-center gap-2">
        <Skeleton className="size-9 rounded-full" />
      </div>
    )
  }

  if (state.status !== "ready") {
    return (
      <div className="ml-auto">
        <TickerChip>Sin conectar</TickerChip>
      </div>
    )
  }

  const label = profileLabel(profile, state.npub)
  // Only ever surface the address as trustworthy once the domain maps it back
  // to this pubkey. A claimed-but-unverified nip05 is shown plainly, without
  // a check, because anyone can put any string in their kind-0.
  const verified = nip05State === "verified"
  const secondary = verified ? profile!.nip05! : shortNpub(state.npub)

  return (
    <div className="ml-auto flex items-center gap-2">
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

        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-3">
              <NostrAvatar pubkey={pubkey} npub={state.npub} size={40} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {state.method === "nip07" ? "Extensión" : "Firmante remoto"}
                </p>
              </div>
            </div>
          </DropdownMenuLabel>

          {profile?.nip05 ? (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5">
                <p className="mb-1 text-xs text-muted-foreground">NIP-05</p>
                <p className="flex items-start gap-1.5 text-sm break-all">
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
                <p className="mt-1 text-xs text-muted-foreground">
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
          <div className="px-2 py-1.5">
            <p className="mb-1 text-xs text-muted-foreground">Tu npub</p>
            <p className="numeric text-xs break-all">{state.npub}</p>
          </div>

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
    </div>
  )
}
