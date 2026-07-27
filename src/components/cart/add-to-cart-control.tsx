"use client"

import { Minus, Plus, Trash2 } from "lucide-react"

import { useCart } from "@/components/cart/cart-provider"
import { maxQty, type CartItem } from "@/lib/domain/cart"
import { Odometer } from "@/components/ui/odometer"
import { cn } from "@/lib/utils"

/**
 * Add / adjust one product, inline at the end of a menu row.
 *
 * Two shapes: a single lime `+` when the item is not in the order, and a
 * `− n +` stepper once it is. The stepper is 102px against the `+`'s 44px, so
 * the control reserves the WIDER of the two at all times and right-aligns
 * inside it. Without that the price column slides 58px sideways the moment
 * anyone taps a row — measured, not theorised — and a menu whose prices no
 * longer line up is exactly what a list layout was meant to fix.
 */
const CONTROL_WIDTH = "min-w-[6.375rem]" // 102px — the stepper's own width
export function AddToCartControl({ item }: { item: CartItem }) {
  const { add, setLineQty, remove, qtyOf, hydrated } = useCart()
  const qty = qtyOf(item.d)
  const cap = maxQty(item)

  // An unpriced product can never be added: a line with no price makes the
  // total silently wrong, and a wrong total at a till is the worst failure
  // this app can produce.
  if (!item.price) return null

  // Nothing until hydration, so the server and the first client paint agree —
  // the quantity comes from localStorage, which has no server value.
  if (!hydrated) return <div aria-hidden className={cn("h-11 shrink-0", CONTROL_WIDTH)} />

  if (qty === 0) {
    return (
      <div className={cn("flex shrink-0 justify-end", CONTROL_WIDTH)}>
        <button
          type="button"
          onClick={() => add(item)}
          aria-label={`Agregar ${item.title} al pedido`}
          className="enter-pop grid size-11 place-items-center rounded-full bg-primary text-primary-foreground transition-transform duration-200 hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Plus className="size-5" aria-hidden />
        </button>
      </div>
    )
  }

  const atCap = qty >= cap
  const left = item.stock === null ? null : item.stock - qty

  return (
    <div className={cn("flex shrink-0 items-center justify-end gap-2", CONTROL_WIDTH)}>
      {left !== null && left <= 3 ? (
        <span className="hidden text-xs text-warning sm:inline">
          {atCap ? "Máximo" : `Quedan ${left}`}
        </span>
      ) : null}

      <div className="enter-pop flex items-center gap-0.5 rounded-full border border-border-strong p-0.5">
        <button
          type="button"
          onClick={() => (qty === 1 ? remove(item.d) : setLineQty(item.d, qty - 1))}
          aria-label={qty === 1 ? `Quitar ${item.title}` : `Quitar uno de ${item.title}`}
          className="grid size-9 place-items-center rounded-full hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {qty === 1 ? (
            <Trash2 className="size-4" aria-hidden />
          ) : (
            <Minus className="size-4" aria-hidden />
          )}
        </button>

        <span className="min-w-5 text-center text-sm font-semibold">
          <Odometer value={qty} format={String} />
        </span>

        <button
          type="button"
          disabled={atCap}
          onClick={() => add(item)}
          aria-label={`Agregar otro ${item.title}`}
          className={cn(
            "grid size-9 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            atCap
              ? "cursor-not-allowed text-muted-foreground"
              : "bg-primary text-primary-foreground"
          )}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>

      <span aria-live="polite" className="sr-only">
        {item.title}: {qty} en el pedido
      </span>
    </div>
  )
}
