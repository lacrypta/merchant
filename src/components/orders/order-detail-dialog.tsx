"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import type { Benefit } from "@/lib/domain/coupon"
import { formatPrice } from "@/lib/domain/price"
import type { SatPriceTable } from "@/lib/domain/rates"
import {
  allocateOrderLineSats,
  type AllocatedZapOrderLine,
  type SatAllocationQuality,
  type ZapOrderTotal,
  type ZapReceiptOrder,
} from "@/lib/domain/zap-order"

/**
 * One order, as both screens that show one read it.
 *
 * Lives here rather than inside the order list because the coupons page shows
 * the same thing: the tab of redemptions opens this dialog for whatever the
 * coupon was spent on. Two dialogs would drift, and the merchant would be
 * looking at the same order rendered two different ways.
 *
 * `id` and `receivedAt` are normalized on purpose. An order that was RECLAIMED
 * — a coupon took it to zero, so it was never invoiced and never receipted —
 * has no receipt to take an id or a timestamp from, and every filter, sort and
 * table cell would otherwise need to know that.
 */
export interface OrderView {
  order: ZapReceiptOrder
  /** Receipt id when it was paid, zap request id when it was reclaimed. */
  id: string
  /** Unix MILLIseconds. When the money arrived, or when the coupon was claimed. */
  receivedAt: number
  source: "receipt" | "claim"
  lines: AllocatedZapOrderLine[]
  quality: SatAllocationQuality
  itemCount: number
  totals: ZapOrderTotal[]
  currencies: string[]
}

export const dateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
})

export const numberFormatter = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 2,
})

export function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

export function formatSats(value: number | null) {
  return value === null ? "—" : `${numberFormatter.format(value)} sat`
}

function aggregateTotals(lines: readonly AllocatedZapOrderLine[]): ZapOrderTotal[] {
  const totals = new Map<string, number>()
  for (const line of lines) {
    if (line.unitAmount === undefined || !line.currency) continue
    totals.set(line.currency, (totals.get(line.currency) ?? 0) + line.unitAmount * line.qty)
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }))
}

/** Allocate the sats across the lines and fill in whatever the tags left out. */
export function buildOrderView(
  order: ZapReceiptOrder,
  rates: SatPriceTable | null,
  /**
   * The coupon's frozen terms, so the discount lands on the line it came off.
   * Null when the merchant's records no longer have them — the totals stay
   * right, only the per-line attribution falls back to proportional.
   */
  benefit: Benefit | null = null
): OrderView | null {
  const anchor = order.receipt ?? order.zapRequest
  if (!anchor) return null

  const allocation = allocateOrderLineSats(order, rates, benefit)
  const totals = order.totals.length > 0 ? order.totals : aggregateTotals(allocation.lines)

  return {
    order,
    id: anchor.id,
    receivedAt: anchor.created_at * 1000,
    source: order.receipt ? "receipt" : "claim",
    lines: allocation.lines,
    quality: allocation.quality,
    itemCount: order.itemsCount ?? allocation.lines.reduce((sum, line) => sum + line.qty, 0),
    totals,
    currencies: [...new Set(totals.map((total) => total.currency))],
  }
}

export function OriginalTotals({ totals }: { totals: readonly ZapOrderTotal[] }) {
  if (totals.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {totals.map((total) => (
        <Badge key={total.currency} variant="outline" className="numeric border-border-strong">
          {formatPrice(total.amount, total.currency)}
        </Badge>
      ))}
    </div>
  )
}

export function allocationLabel(quality: SatAllocationQuality) {
  if (quality === "exact") return "Asignación exacta"
  if (quality === "estimated") return "Sats estimados"
  return "Sats sin asignar"
}

export function MetricCard({
  label,
  value,
  note,
  primary = false,
}: {
  label: string
  value: string
  note: string
  primary?: boolean
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        primary ? "border-primary/35 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={`numeric mt-2 text-2xl font-bold tracking-tight ${
          primary ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

export function OrderDetailDialog({
  view,
  productTitles,
  onOpenChange,
}: {
  view: OrderView | null
  productTitles: ReadonlyMap<string, string>
  onOpenChange: (open: boolean) => void
}) {
  const open = view !== null
  /**
   * Three different things, and calling them all "cobrada" would be a lie in two
   * of the cases:
   *
   *   paid      — a zap receipt says the money arrived.
   *   reclaimed — a coupon took the total to zero. Nothing to pay, nothing to
   *               wait for.
   *   invoiced  — filed when the coupon was redeemed, with an invoice still
   *               outstanding. Only its receipt can promote it to paid, and
   *               that receipt is its own row in the order book.
   */
  const settlement =
    view?.source === "receipt"
      ? "paid"
      : (view?.order.receiptSats ?? 0) === 0
        ? "reclaimed"
        : "invoiced"
  const reclaimed = settlement === "reclaimed"

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        {view ? (
          <>
            <ResponsiveDialogHeader className="pr-10">
              <div className="flex flex-wrap items-center gap-2">
                <ResponsiveDialogTitle>Orden {shortId(view.id)}</ResponsiveDialogTitle>
                {settlement === "paid" ? (
                  <Badge className="border-success/30 bg-success-bg text-success">
                    Cobrada
                  </Badge>
                ) : settlement === "reclaimed" ? (
                  <Badge className="border-primary/30 bg-primary/10 text-primary">
                    Reclamada
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-border-strong">
                    Con cupón
                  </Badge>
                )}
                {view.quality === "estimated" ? (
                  <Badge variant="outline" className="border-warning/40 text-warning">
                    sats estimados
                  </Badge>
                ) : null}
              </div>
              <ResponsiveDialogDescription>
                {settlement === "paid" ? "Recibida" : settlement === "reclaimed" ? "Reclamada" : "Pedida"}{" "}
                {dateFormatter.format(view.receivedAt)}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>

            <div className="space-y-6">
              <section
                aria-label="Resumen de la orden"
                className="grid gap-3 sm:grid-cols-2"
              >
                <MetricCard
                  label={settlement === "invoiced" ? "A cobrar" : "Cobrado"}
                  value={reclaimed ? "Sin cargo" : formatSats(view.order.receiptSats)}
                  note={
                    reclaimed
                      ? "Cubierta por el cupón"
                      : settlement === "invoiced"
                        ? "Importe facturado al canjear"
                        : allocationLabel(view.quality)
                  }
                  primary
                />
                <MetricCard
                  label="Unidades"
                  value={numberFormatter.format(view.itemCount)}
                  note={`${view.lines.length} líneas de producto`}
                />
              </section>

              {/* Without this the numbers do not add up: the item totals are
                  GROSS, and what the invoice charged is gross minus this. */}
              {view.order.coupon ? (
                <section
                  aria-label="Cupón aplicado"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      Cupón {view.order.coupon.name || view.order.coupon.type}
                    </p>
                    <p className="truncate-middle numeric text-xs text-muted-foreground">
                      {view.order.coupon.id}
                    </p>
                  </div>
                  {view.order.discounts.length > 0 ? (
                    <p className="numeric text-sm font-bold text-success">
                      −
                      {view.order.discounts
                        .map((d) => formatPrice(d.amount, d.currency))
                        .join(" − ")}
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section aria-labelledby="order-items-title">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 id="order-items-title" className="text-h3">
                    Ítems del pedido
                  </h3>
                  <OriginalTotals totals={view.totals} />
                </div>

                {view.lines.length > 0 ? (
                  <ul className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
                    {view.lines.map((line, index) => (
                      <li
                        key={`${line.d}-${index}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3"
                      >
                        <p className="min-w-0 truncate text-sm font-semibold">
                          {productTitles.get(line.d) ?? `Producto ${shortId(line.d)}`}
                        </p>
                        <p
                          className="numeric text-right text-sm font-bold"
                          title={
                            view.quality === "estimated"
                              ? "Estimado con la cotización actual y reconciliado al total del receipt"
                              : undefined
                          }
                        >
                          {line.sats === null
                            ? "—"
                            : `${view.quality === "estimated" ? "≈ " : ""}${formatSats(line.sats)}`}
                        </p>
                        <p className="numeric text-xs text-muted-foreground">
                          Cantidad ×{line.qty}
                          {line.unitAmount !== undefined && line.currency
                            ? ` · ${formatPrice(line.unitAmount, line.currency)} c/u`
                            : ""}
                        </p>
                        {line.sats !== null && line.qty > line.freeQty && line.qty > 1 ? (
                          <p className="numeric text-right text-xs text-muted-foreground">
                            {view.quality === "estimated" ? "≈ " : ""}
                            {formatSats(line.sats / (line.qty - line.freeQty))} c/u
                          </p>
                        ) : null}

                        {/* The coupon lands HERE, on the product it was spent
                            on. Spread across every line it would read as
                            "everything was a bit cheaper", which is not what
                            happened and not what the merchant gave away. */}
                        {line.discount > 0 && line.currency ? (
                          <>
                            <p className="text-xs font-medium text-success">
                              {line.freeQty > 0
                                ? `${line.freeQty} gratis por el cupón`
                                : "Descuento del cupón"}
                            </p>
                            <p className="numeric text-right text-xs font-medium text-success">
                              −{formatPrice(line.discount, line.currency)}
                            </p>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-sm text-muted-foreground">
                    Esta orden no incluye el detalle de ítems dentro del zap request.
                  </p>
                )}

                {view.lines.length === 0 && view.order.itemsCount ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    El request declara {view.order.itemsCount} unidades sin detalle por
                    línea.
                  </p>
                ) : null}
              </section>

              <section aria-labelledby="order-source-title">
                <h3 id="order-source-title" className="sr-only">
                  Referencias de Nostr
                </h3>
                <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                  <div className="bg-card px-4 py-3">
                    <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Zap receipt
                    </dt>
                    <dd className="numeric mt-1 break-all text-xs font-medium">
                      {view.order.receipt?.id ??
                        (reclaimed
                          ? "Sin cobro — reclamada con cupón"
                          : "Todavía no llegó a los relays")}
                    </dd>
                  </div>
                  <div className="bg-card px-4 py-3">
                    <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Zap request
                    </dt>
                    <dd className="numeric mt-1 break-all text-xs font-medium">
                      {view.order.zapRequest?.id ?? "No incluido en el receipt"}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cerrar</Button>
              </ResponsiveDialogClose>
            </ResponsiveDialogFooter>
          </>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
