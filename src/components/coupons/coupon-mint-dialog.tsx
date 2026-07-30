"use client"

import { Check, Copy, ShieldCheck } from "lucide-react"
import * as React from "react"

import type { CouponJson, MintedCoupon } from "@/components/coupons/use-coupons"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { describeBenefit } from "@/lib/domain/coupon"

/**
 * Shows a coupon that was just issued.
 *
 * PURELY PRESENTATIONAL, and that is the point: minting happens in the click
 * handler that opens this, never in an effect here. An effect would mint again
 * on every remount — and React's development StrictMode remounts every
 * component once on purpose, which issued two coupons for one tap and quietly
 * ate two of the merchant's allowance. Issuing a coupon is a user's decision,
 * so it belongs on the user's click.
 *
 * The QR is the storefront checkout URL with the nonce in the query string, so
 * scanning it starts a purchase with the discount already applied — no typing a
 * code. The nonce is also shown as text, because a phone with a dead camera is
 * a normal Tuesday at a market stall.
 */
export interface MintAttempt {
  coupon: CouponJson
  /** null while the request is in flight. */
  minted: MintedCoupon | null
  error: string | null
}

export function CouponMintDialog({
  attempt,
  npub,
  onClose,
}: {
  /** null closes the dialog. */
  attempt: MintAttempt | null
  /** The merchant's npub — the storefront path the QR points at. */
  npub: string
  onClose: () => void
}) {
  return (
    <ResponsiveDialog open={!!attempt} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Cupón emitido</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {attempt?.coupon.benefit
              ? describeBenefit(attempt.coupon.benefit)
              : "Mostrale el código a quien lo va a usar."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {attempt?.error ? (
          <p
            role="alert"
            className="rounded-xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger"
          >
            {attempt.error}
          </p>
        ) : attempt?.minted ? (
          <Issued minted={attempt.minted} npub={npub} />
        ) : (
          <div className="space-y-3 py-2">
            <Skeleton className="mx-auto aspect-square w-full max-w-[240px] rounded-2xl" />
            <Skeleton className="mx-auto h-5 w-48" />
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function Issued({ minted, npub }: { minted: MintedCoupon; npub: string }) {
  const claimUrl = `${window.location.origin}/s/${npub}/checkout?coupon=${minted.nonce}`

  return (
    <div className="space-y-4">
      <NonceQr url={claimUrl} />

      <div className="space-y-2 text-center">
        <p className="text-xs text-muted-foreground">Código del cupón</p>
        <p className="numeric text-lg font-semibold break-all">{minted.nonce}</p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <CopyButton value={minted.nonce} label="Copiar código" />
        <CopyButton value={claimUrl} label="Copiar link" />
      </div>

      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        Firmado por este servidor: cualquier punto de venta puede verificarlo sin
        conexión.
      </p>
    </div>
  )
}

/**
 * Same white-card treatment as the invoice QR: phone cameras need the contrast
 * and the quiet zone, and this is a moment where scannable beats on-brand.
 */
function NonceQr({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const QR = (await import("qrcode")).default
        const image = await QR.toDataURL(url, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 512,
          color: { dark: "#0A0A0A", light: "#FFFFFF" },
        })
        if (!cancelled) setDataUrl(image)
      } catch {
        /* the code and the copy buttons still work */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <div className="mx-auto w-full max-w-[240px] rounded-2xl bg-white p-3">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt="Código QR del cupón" className="size-full" />
      ) : (
        <Skeleton className="aspect-square w-full rounded-lg bg-neutral-200" />
      )}
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? (
        <Check className="size-4" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
      {copied ? "Copiado" : label}
    </Button>
  )
}
