"use client"

import { AlertTriangle, Minus, Plus, Trash2 } from "lucide-react"
import * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { Odometer } from "@/components/ui/odometer"
import { usePresenceList } from "@/hooks/use-presence-list"
import { cn } from "@/lib/utils"
import { Approx, roundFor } from "@/components/cart/money"
import { RateFreshnessChip } from "@/components/cart/rate-freshness-chip"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { subtotalsByCurrency, type CartLine } from "@/lib/domain/cart"
import { formatPrice } from "@/lib/domain/price"
import { fromSats } from "@/lib/domain/rates"

/**
 * The body of the cart: currency, reconciliation notices, lines, totals.
 *
 * Shared verbatim by the mobile drawer and the desktop sidebar. Two copies of
 * this markup would drift the moment either one is touched, and the one place
 * that must never disagree with itself is the thing showing the total.
 */
export function CartContents({
  compact,
  emptyMessage,
}: {
  compact?: boolean
  /** Shown once the last line has finished animating away. */
  emptyMessage?: React.ReactNode
}) {
  const {
    merchant,
    cart,
    issues,
    quote,
    rates,
    displayCurrency,
    setDisplayCurrency,
    add,
    setLineQty,
    remove,
    catalog,
  } = useCart()

  const total =
    quote && rates ? fromSats(quote.exactSats, displayCurrency, rates) : null
  const unquotable = quote?.unquotable ?? []

  const currencies = React.useMemo(() => {
    const seen = new Set<string>(["ARS", "USD", "SAT"])
    for (const l of cart.lines) seen.add(l.currency)
    return [...seen].filter((c) => c === "SAT" || rates?.[c])
  }, [cart.lines, rates])

  const lineKey = React.useCallback((l: CartLine) => l.d, [])
  const presence = usePresenceList(cart.lines, lineKey)

  // Same rule as the storefront list: a shop with no photographs anywhere
  // gets no thumbnail column, rather than a stack of empty placeholders.
  const showImage = React.useMemo(
    () => Object.values(catalog).some((i) => !!i.thumbUrl),
    [catalog]
  )

  // Owns the empty state so the HOSTS can render this unconditionally. If a
  // host swapped it out at count === 0, removing the last line — much the most
  // common removal — would unmount the presence list mid-exit and the row
  // would vanish instantly instead of animating.
  if (presence.length === 0) {
    return emptyMessage ? <>{emptyMessage}</> : null
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Moneda"
          value={displayCurrency}
          onValueChange={setDisplayCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
        {compact ? null : <RateFreshnessChip />}
      </div>

      {issues.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {issues.map((issue, i) => (
            <li
              key={`${issue.d}-${i}`}
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{describeIssue(issue.kind)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* No height cap here: both hosts already own their own scrolling — the
          drawer via ResponsiveDialogContent, the sidebar via its flex column.
          A third cap nested inside those produced a scroll area inside a
          scroll area. */}
      <ul className="space-y-2">
        {presence.map(({ key, item: line, leaving }) => {
          const item = catalog[line.d]
          const cap = item?.stock ?? Number.POSITIVE_INFINITY
          return (
            <li
              key={key}
              className={cn(
                "enter-row flex items-center gap-3 rounded-xl border border-border bg-card p-2",
                leaving && "is-leaving"
              )}
            >
              {showImage ? (
                <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                  {line.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={line.thumbUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <div aria-hidden className="grid-flat size-full opacity-40" />
                  )}
                </div>
              ) : null}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{line.title}</p>
                <p className="numeric text-xs text-muted-foreground">
                  {formatPrice(line.unitAmount, line.currency)}
                  {line.preOrder ? (
                    <span className="ml-1 text-warning">· Pre-venta</span>
                  ) : null}
                </p>
                <Approx
                  amount={line.unitAmount * line.qty}
                  currency={line.currency}
                  className="numeric text-xs text-muted-foreground"
                />
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    line.qty === 1 ? remove(line.d) : setLineQty(line.d, line.qty - 1)
                  }
                  aria-label={`Quitar uno de ${line.title}`}
                  className="tap-44 grid size-8 place-items-center rounded-full border border-border-strong hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {line.qty === 1 ? (
                    <Trash2 className="size-3.5" aria-hidden />
                  ) : (
                    <Minus className="size-3.5" aria-hidden />
                  )}
                </button>
                <span className="w-5 text-center text-sm font-semibold">
                  <Odometer value={line.qty} format={String} />
                </span>
                <button
                  type="button"
                  disabled={!item || line.qty >= cap}
                  onClick={() => item && add(item)}
                  aria-label={`Agregar otro ${line.title}`}
                  className="tap-44 grid size-8 place-items-center rounded-full border border-border-strong hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
                >
                  <Plus className="size-3.5" aria-hidden />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
        {subtotalsByCurrency(cart).map((s) => (
          <div key={s.currency} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Subtotal {s.currency}</dt>
            <dd>
              <Odometer
                value={s.amount}
                format={(n) => formatPrice(n, s.currency)}
              />
            </dd>
          </div>
        ))}
        {total !== null ? (
          <div className="flex items-baseline justify-between gap-2 pt-1.5">
            <dt className="font-semibold">Total</dt>
            <dd className="text-price text-primary">
              <Odometer
                value={roundFor(total, displayCurrency)}
                format={(n) => formatPrice(n, displayCurrency)}
              />
            </dd>
          </div>
        ) : null}
        {quote && displayCurrency !== "SAT" ? (
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <dt>Se cobra en sats</dt>
            {/* The wallet will show sats; hiding them here is a surprise at
                the worst possible moment. */}
            <dd>
              ≈ <Odometer value={quote.sats} format={(n) => formatPrice(n, "SAT")} />
            </dd>
          </div>
        ) : null}
      </dl>

      {compact ? (
        <div className="mt-3">
          <RateFreshnessChip />
        </div>
      ) : null}

      {unquotable.length > 0 ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          No podemos cotizar {unquotable.join(", ")} a sats. Sacá esos productos o
          pedile al comercio que los cotice en ARS, USD o SAT.
        </p>
      ) : null}

      {!merchant.canCheckout ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          Este comercio todavía no acepta pagos por Lightning. Podés mostrarle
          esta lista en el mostrador.
        </p>
      ) : null}
    </>
  )
}

export function describeIssue(kind: string): string {
  switch (kind) {
    case "gone":
      return "Sacamos un producto que el comercio dio de baja."
    case "sold-out":
      return "Sacamos un producto que se quedó sin stock."
    case "stock-clamped":
      return "Ajustamos una cantidad al stock disponible."
    case "price-changed":
      return "Un precio cambió desde que lo agregaste."
    default:
      return "Actualizamos tu pedido con el catálogo."
  }
}

/** Whether the cart can be taken to checkout right now, and why not. */
export function useCanPay(): boolean {
  const { merchant, count, quote } = useCart()
  return merchant.canCheckout && count > 0 && !!quote && quote.unquotable.length === 0
}
