"use client"

import { Loader2, TicketPercent, X } from "lucide-react"
import * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  describeBenefit,
  isValidNonce,
  parseBenefit,
  type AppliedCoupon,
} from "@/lib/domain/coupon"
import { formatPrice } from "@/lib/domain/price"

/**
 * Where a shopper redeems a coupon.
 *
 * Applying only VALIDATES (GET) — it never redeems. The nonce is spent later, at
 * the moment an invoice is generated, so somebody who pastes a code and then
 * closes the tab has not burned their coupon.
 *
 * A `?coupon=` in the URL is applied automatically once, because that is what a
 * minted QR points at: the customer scanned a code, they should not then have to
 * type it.
 */

interface ClaimCheck {
  status: "minted" | "claimed" | "expired" | "voided"
  coupon: unknown
  name: string
  description: string
  /** The OWNER's npub. Must match this storefront's merchant. */
  npub: string
  image: string | null
  nonce: string
  couponId: string
}

const MESSAGES: Record<string, string> = {
  claimed: "Ese cupón ya fue usado.",
  expired: "Ese cupón está vencido.",
  voided: "Ese cupón fue anulado.",
}

export function CouponField() {
  const { merchant, coupon, priced, applyCoupon, removeCoupon, catalog } = useCart()

  const [value, setValue] = React.useState("")
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const apply = React.useCallback(
    async (nonce: string) => {
      setError(null)
      if (!isValidNonce(nonce)) {
        setError("Ese código no es válido.")
        return
      }

      setChecking(true)
      try {
        const res = await fetch(`/api/coupons/claim?nonce=${encodeURIComponent(nonce)}`, {
          cache: "no-store",
        })
        const data = (await res.json()) as ClaimCheck & { error?: string }

        if (!res.ok) {
          setError(data.error ?? "No pudimos validar el cupón.")
          return
        }
        if (data.status !== "minted") {
          setError(MESSAGES[data.status] ?? "Ese cupón no se puede usar.")
          return
        }

        /**
         * The coupon has to belong to THIS shop.
         *
         * One deployment serves every merchant's storefront, and the claim
         * endpoint answers for any nonce it knows — it has to, because a POS
         * validating a coupon has no storefront context. Without this check a
         * shopper could carry a 50%-off coupon from one shop to another, and the
         * second merchant would eat a discount they never offered.
         */
        if (data.npub !== merchant.npub) {
          setError("Ese cupón es de otro comercio.")
          return
        }

        const benefit = parseBenefit(data.coupon)
        if (!benefit.ok) {
          setError("No entendimos ese cupón. Pedile otro al comercio.")
          return
        }

        const applied: AppliedCoupon = {
          nonce: data.nonce,
          couponId: data.couponId,
          name: data.name,
          benefit: benefit.value,
          ...(data.image ? { image: data.image } : {}),
        }
        applyCoupon(applied)
        setValue("")
      } catch {
        setError("No pudimos validar el cupón. Revisá tu conexión.")
      } finally {
        setChecking(false)
      }
    },
    [applyCoupon, merchant.npub]
  )

  /**
   * Auto-apply from the URL, exactly once per page load.
   *
   * A ref rather than a dependency on `coupon`: if the shopper deliberately
   * removes the coupon, re-adding it because the query string is still there
   * would make the "quitar" button look broken.
   *
   * The guard is inside the callback, NOT before scheduling it. Deferring the
   * call keeps a setState out of the effect body, but the cleanup cancels that
   * timer — so a guard set before scheduling would be left standing with
   * nothing pending, and React's development StrictMode (which mounts, cleans
   * up and mounts again) made a scanned QR silently do nothing. Checking on the
   * way out instead means the last scheduled call is the one that runs, once.
   */
  const autoApplied = React.useRef(false)
  React.useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("coupon")
    if (!fromUrl) return

    const timer = window.setTimeout(() => {
      if (autoApplied.current) return
      autoApplied.current = true
      void apply(fromUrl)
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (coupon) {
    const unmet = priced?.unmet ?? null
    const discount = priced?.entries ?? []

    return (
      <section className="rounded-2xl border border-primary/40 bg-surface-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <TicketPercent className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="truncate">{coupon.name}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {describeBenefit(coupon.benefit, (d) => catalog[d]?.title)}
            </p>

            {unmet ? (
              <p className="text-xs text-warning">{unmetMessage(unmet, catalog)}</p>
            ) : discount.length > 0 ? (
              <p className="numeric text-sm text-success">
                −{discount.map((d) => formatPrice(d.amount, d.currency)).join(" − ")}
              </p>
            ) : null}
          </div>

          <Button
            variant="ghost"
            size="sm"
            aria-label="Quitar el cupón"
            onClick={() => {
              removeCoupon()
              setError(null)
            }}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-2">
      <form
        noValidate
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void apply(value.trim())
        }}
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="¿Tenés un cupón?"
          aria-label="Código de cupón"
          aria-invalid={!!error}
          className="numeric"
        />
        <Button type="submit" variant="outline" disabled={checking || !value.trim()}>
          {checking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Aplicar
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Say what is missing, not that the coupon failed.
 *
 * "Agregá una empanada más" is an instruction the shopper can act on; "el cupón
 * no aplica" reads as a broken coupon and sends them to the counter to complain.
 */
function unmetMessage(
  unmet: NonNullable<ReturnType<typeof useCart>["priced"]>["unmet"],
  catalog: ReturnType<typeof useCart>["catalog"]
): string {
  if (!unmet) return ""
  switch (unmet.kind) {
    case "empty-cart":
      return "Agregá productos para usar el cupón."
    case "unquotable":
      return `No pudimos convertir ${unmet.currency} a sats todavía.`
    case "needs-products": {
      const names = unmet.products.map((p) => {
        const title = p.d ? catalog[p.d]?.title : undefined
        return title ? `${p.qty} × ${title}` : `${p.qty} producto${p.qty === 1 ? "" : "s"}`
      })
      // "any of these" and "all of these" are different instructions, and
      // joining with "y" would silently turn the first into the second.
      if (unmet.anyOf && names.length > 1) {
        return `Este cupón aplica a: ${names.map((n) => n.replace(/^1 × /, "")).join(", ")}.`
      }
      return `Te falta agregar ${names.join(" y ")} para que aplique.`
    }
  }
}
