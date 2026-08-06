"use client"

import * as React from "react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { useRedemptions, type RedemptionJson } from "@/components/coupons/use-coupons"
import {
  OrderDetailDialog,
  buildOrderView,
  shortId,
  type OrderView,
} from "@/components/orders/order-detail-dialog"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useRates } from "@/hooks/use-rates"
import { describeBenefit } from "@/lib/domain/coupon"
import { parseZapRequestOrder } from "@/lib/domain/zap-order"

const dateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
})

/**
 * Redeemed coupons, and what each one bought.
 *
 * The order comes from the kind-9734 filed when the coupon was claimed, so it
 * opens the SAME dialog the order list uses — a redemption and an order are the
 * same thing seen from two sides, and rendering them differently would have the
 * merchant comparing two layouts of one sale.
 *
 * A redemption with no order is normal, not an error: a coupon scanned at a
 * counter never went through a checkout, and neither did anything redeemed
 * before this app started filing them.
 */
export function RedemptionsSection() {
  const { redemptions, loading, error } = useRedemptions()
  const { products } = useCatalog()
  const { rates } = useRates()
  const [selected, setSelected] = React.useState<string | null>(null)

  const productTitles = React.useMemo(
    () => new Map(products.map((product) => [product.d, product.title])),
    [products]
  )
  const titleOf = React.useCallback(
    (d: string) => productTitles.get(d),
    [productTitles]
  )

  const views = React.useMemo(() => {
    const out = new Map<string, OrderView>()
    for (const r of redemptions) {
      if (!r.order) continue
      // 0, not null: a reclaimed order charged nothing, and that is a known
      // amount rather than a missing one. A paid one carries its real total.
      const view = buildOrderView(
        parseZapRequestOrder(r.order, (r.amountMsat ?? 0) / 1000),
        rates?.satPrice ?? null,
        // The snapshot frozen when this very coupon was minted, so the discount
        // lands on the product it was spent on.
        r.benefit
      )
      if (view) out.set(r.nonce, view)
    }
    return out
  }, [redemptions, rates?.satPrice])

  if (error) {
    return (
      <p
        role="alert"
        className="rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger"
      >
        {error.message}
      </p>
    )
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full rounded-2xl" />
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    )
  }

  if (redemptions.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
        Todavía no se canjeó ningún cupón.
      </p>
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <caption className="sr-only">
              Cupones canjeados, con la fecha, el código y el tipo de cupón
            </caption>
            <thead className="border-b border-border bg-surface-2">
              <tr>
                <Th>Fecha</Th>
                <Th>Código</Th>
                <Th>Cupón</Th>
                <Th>Tipo</Th>
                <Th align="right">Orden</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {redemptions.map((r) => (
                <RedemptionRow
                  key={r.nonce}
                  redemption={r}
                  view={views.get(r.nonce) ?? null}
                  titleOf={titleOf}
                  onOpen={() => setSelected(r.nonce)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <OrderDetailDialog
        view={(selected && views.get(selected)) || null}
        productTitles={productTitles}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </>
  )
}

function RedemptionRow({
  redemption: r,
  view,
  titleOf,
  onOpen,
}: {
  redemption: RedemptionJson
  view: OrderView | null
  titleOf: (d: string) => string | undefined
  onOpen: () => void
}) {
  const openable = view !== null

  return (
    <tr
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-label={openable ? `Ver la orden del cupón ${r.nonce}` : undefined}
      onClick={openable ? onOpen : undefined}
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
      className={
        openable
          ? "cursor-pointer transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-none"
          : undefined
      }
    >
      <Td>
        <time dateTime={new Date(r.claimedAt * 1000).toISOString()}>
          {dateFormatter.format(r.claimedAt * 1000)}
        </time>
      </Td>
      <Td>
        <span className="numeric text-xs font-medium">{r.nonce}</span>
      </Td>
      <Td>
        <span className="truncate font-medium">{r.name}</span>
      </Td>
      <Td>
        {r.benefit ? (
          describeBenefit(r.benefit, titleOf)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
      <Td align="right">
        {view ? (
          <span className="flex items-center justify-end gap-2">
            {r.amountMsat === 0 ? (
              <Badge className="border-primary/30 bg-primary/10 text-primary">
                Reclamada
              </Badge>
            ) : null}
            <span className="numeric text-xs font-medium">{shortId(view.id)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Sin orden asociada</span>
        )}
      </Td>
    </tr>
  )
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <td
      className={`px-4 py-3 align-middle text-sm ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </td>
  )
}
