"use client"

import { Ban, Check, Copy, Loader2, TicketX } from "lucide-react"
import * as React from "react"

import type { CouponJson, MintJson } from "@/components/coupons/use-coupons"
import { useCouponMints } from "@/components/coupons/use-coupons"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/**
 * Everything issued for one coupon: when it went out, who issued it, whether it
 * was redeemed — and the way to cancel one that has not been.
 *
 * The merchant needs this the moment something goes wrong: a QR sent to the
 * wrong customer, a cashier who tapped "Emitir" twice, a promo called off. Up
 * to now those coupons were simply out there, valid, with no way to take them
 * back.
 */
export function CouponMintsPanel({ coupon }: { coupon: CouponJson }) {
  const { mints, loading, error, voidMint } = useCouponMints(coupon.id)
  const [confirming, setConfirming] = React.useState<MintJson | null>(null)
  const [voiding, setVoiding] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const live = mints.filter((m) => m.status === "minted").length
  const claimed = mints.filter((m) => m.status === "claimed").length
  const voided = mints.filter((m) => m.status === "voided").length

  async function handleVoid(mint: MintJson) {
    setActionError(null)
    setVoiding(mint.nonce)
    try {
      await voidMint(mint.nonce)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "No pudimos anular ese cupón.")
    } finally {
      setVoiding(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-warning">
        {error.message}
      </p>
    )
  }

  if (mints.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface-2 px-6 py-10 text-center">
        <TicketX className="mx-auto size-7 text-muted-foreground" aria-hidden />
        <p className="mt-3 font-medium">Todavía no emitiste ninguno</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Cuando toques «Emitir», cada cupón que entregues aparece acá con su
          estado.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Tally label="Sin usar" value={live} tone="live" />
        <Tally label="Canjeados" value={claimed} tone="claimed" />
        {voided > 0 ? <Tally label="Anulados" value={voided} tone="voided" /> : null}
      </div>

      {actionError ? (
        <p role="alert" className="text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
        {mints.map((mint) => (
          <li
            key={mint.nonce}
            className="flex flex-wrap items-center justify-between gap-3 bg-card px-4 py-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-1.5">
                <span className="numeric truncate text-sm">{mint.nonce}</span>
                <CopyButton value={mint.nonce} />
              </p>
              <p className="text-xs text-muted-foreground">
                <MintTimeline mint={mint} />
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={mint.status} />
              {mint.status === "minted" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-danger"
                  disabled={voiding === mint.nonce}
                  onClick={() => setConfirming(mint)}
                >
                  {voiding === mint.nonce ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Ban className="size-4" aria-hidden />
                  )}
                  Anular
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Anular este cupón emitido?</AlertDialogTitle>
            <AlertDialogDescription>
              Quien lo tenga no va a poder canjearlo: al escanearlo le va a decir
              que fue anulado. Se libera un lugar del máximo, así que podés emitir
              otro en su lugar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming
                setConfirming(null)
                if (target) void handleVoid(target)
              }}
            >
              Anular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function MintTimeline({ mint }: { mint: MintJson }) {
  const when = (unix: number) => new Date(unix * 1000).toLocaleString("es-AR")
  if (mint.status === "claimed" && mint.claimedAt) {
    return <>Canjeado el {when(mint.claimedAt)}</>
  }
  if (mint.status === "voided" && mint.voidedAt) {
    return <>Anulado el {when(mint.voidedAt)}</>
  }
  return <>Emitido el {when(mint.mintedAt)}</>
}

function StatusBadge({ status }: { status: MintJson["status"] }) {
  const map = {
    minted: { label: "Sin usar", className: "border-border text-muted-foreground" },
    claimed: {
      label: "Canjeado",
      className: "border-success/40 bg-success-bg text-success",
    },
    voided: { label: "Anulado", className: "border-danger/40 bg-danger-bg text-danger" },
  }[status]

  return (
    <Badge variant="outline" className={map.className}>
      {map.label}
    </Badge>
  )
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "live" | "claimed" | "voided"
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        tone === "claimed"
          ? "border-success/40 bg-success-bg text-success"
          : tone === "voided"
            ? "border-danger/40 bg-danger-bg text-danger"
            : "border-border text-muted-foreground"
      )}
    >
      <span className="numeric font-semibold">{value}</span>
      {label}
    </span>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Copiar el código del cupón"
      className="size-6 shrink-0 text-muted-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true))
      }}
    >
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </Button>
  )
}
