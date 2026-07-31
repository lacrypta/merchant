"use client"

import { Loader2, Trash2, UserPlus } from "lucide-react"
import * as React from "react"

import type { MinterJson } from "@/components/coupons/use-coupons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NIP05_RE, looksLikeHandle } from "@/lib/domain/handle"

/**
 * Who else can hand out this merchant's coupons.
 *
 * These npubs can mint, and nothing else: they cannot create, edit or delete a
 * coupon, and they cannot see another merchant's. That is what makes it safe to
 * put one on a cashier's phone.
 */
export function MintersSection({
  minters,
  onAdd,
  onRemove,
}: {
  minters: MinterJson[]
  onAdd: (pubkey: string, label: string) => Promise<void>
  onRemove: (pubkey: string) => Promise<void>
}) {
  const [value, setValue] = React.useState("")
  const [label, setLabel] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [confirming, setConfirming] = React.useState<MinterJson | null>(null)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [removeError, setRemoveError] = React.useState<string | null>(null)

  /**
   * Removal can fail — an expired NIP-98 signature, a refused bunker prompt, a
   * dead database — and the row simply staying put is not an answer. Without
   * this the merchant is left believing a cashier lost access when they did
   * not, which is the one belief this screen must never produce.
   */
  async function handleRemove(minter: MinterJson) {
    setRemoveError(null)
    setRemoving(minter.pubkey)
    try {
      await onRemove(minter.pubkey)
    } catch (err) {
      setRemoveError(
        err instanceof Error
          ? err.message
          : `No pudimos quitar a ${minter.label || minter.npub}.`
      )
    } finally {
      setRemoving(null)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const trimmed = value.trim().replace(/^nostr:/i, "")
    if (!trimmed) {
      setError("Ingresá un npub o una dirección NIP-05.")
      return
    }
    // Checked here as well as on the server so a typo costs a keystroke rather
    // than a signature and a round trip. `looksLikeHandle` is the same shape
    // check the landing page uses — npub, nprofile, hex or NIP-05.
    if (!looksLikeHandle(trimmed)) {
      setError("Eso no parece un npub, una clave hex ni una dirección NIP-05.")
      return
    }

    setBusy(true)
    try {
      // A NIP-05 address is the most useful name the merchant could give this
      // row, and they already typed it — no reason to make them type it twice.
      const isAddress = trimmed.includes("@") && NIP05_RE.test(trimmed)
      await onAdd(trimmed, label.trim() || (isAddress ? trimmed : ""))
      setValue("")
      setLabel("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos agregar el emisor.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Quién puede emitir</h2>
        <p className="text-sm text-muted-foreground">
          Estos npubs pueden emitir tus cupones desde su propio punto de venta. No
          pueden crearlos ni editarlos.
        </p>
      </div>

      <form noValidate onSubmit={handleAdd} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="minter-npub">npub o NIP-05</Label>
            <Input
              id="minter-npub"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="npub1… o caja@tutienda.ar"
              className="numeric"
              aria-invalid={!!error}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="minter-label">Nombre</Label>
            <Input
              id="minter-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Caja 2"
            />
          </div>
          <Button type="submit" variant="outline" disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserPlus className="size-4" aria-hidden />
            )}
            Agregar
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>

      {minters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Por ahora solo emitís vos, con tu propio npub.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {minters.map((m) => (
            <li key={m.pubkey} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                {m.label ? <p className="truncate text-sm font-medium">{m.label}</p> : null}
                <p className="truncate-middle numeric text-xs text-muted-foreground">
                  {m.npub}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Quitar ${m.label || m.npub}`}
                disabled={removing === m.pubkey}
                onClick={() => setConfirming(m)}
              >
                {removing === m.pubkey ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {removeError ? (
        <p role="alert" className="text-sm text-danger">
          {removeError}
        </p>
      ) : null}

      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Quitar este emisor?</AlertDialogTitle>
            <AlertDialogDescription>
              No va a poder emitir cupones nuevos. Los que ya emitió siguen valiendo —
              están en manos de tus clientes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming
                setConfirming(null)
                if (target) void handleRemove(target)
              }}
            >
              Quitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
