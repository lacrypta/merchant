"use client"

import { Loader2, ShoppingBag, Zap } from "lucide-react"
import { useRouter } from "next/navigation"

import { CartContents, useCanPay } from "@/components/cart/cart-contents"
import { useCart } from "@/components/cart/cart-provider"
import { Button } from "@/components/ui/button"
import { Odometer } from "@/components/ui/odometer"

/**
 * The docked cart, on screens wide enough to spare the column.
 *
 * Always rendered at `lg` and up, empty or not — if it appeared only once
 * something was added, the product list beside it would jump narrower on the
 * first tap. A stable column costs one quiet empty state and buys a layout
 * that never reflows while someone is reading prices.
 *
 * Sticky at `top-20`: clear of the 64px navbar plus a hair, so the order stays
 * on screen for the whole scroll of a long menu — which is the entire reason
 * to spend a column on it rather than keep the modal.
 */
export function CartAside() {
  const { merchant, catalog, catalogReady, count, hydrated, clear } = useCart()
  const router = useRouter()
  const canPay = useCanPay()

  return (
    <aside
      aria-label="Tu pedido"
      className="hidden lg:sticky lg:top-20 lg:block lg:w-80 lg:shrink-0"
    >
      {/*
        A flex column capped to the viewport, NOT a card that grows with the
        order. `position: sticky` silently stops pinning anything taller than
        the viewport — it scrolls away like a static element — so a twelve-item
        cart would take the pay button off screen and strand the customer.
        Header and footer hold their ground; only the middle scrolls.
      */}
      <div className="enter-pop flex max-h-[calc(100dvh-6rem)] flex-col rounded-2xl border border-border bg-surface-2 p-4">
        <h2 className="mb-3 flex shrink-0 items-center gap-2 text-sm font-semibold">
          <ShoppingBag className="size-4 text-primary" aria-hidden />
          Tu pedido
          {hydrated && count > 0 ? (
            <span className="ml-auto text-muted-foreground">
              <Odometer value={count} format={String} />
            </span>
          ) : null}
        </h2>

        {/* `hydrated` gates the whole body: the cart comes from localStorage,
            which has no value during SSR, so rendering lines before it flips
            would be a hydration mismatch on the first paint. `catalogReady`
            joins it because the catalog now streams in — see EmptyHint. */}
        {!hydrated || !catalogReady ? (
          <EmptyHint state="loading" />
        ) : (
          <>
            <div className="-mr-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
              <CartContents
                compact
                emptyMessage={
                  <EmptyHint
                    state={
                      Object.keys(catalog).length === 0 ? "no-products" : "empty"
                    }
                  />
                }
              />
            </div>

            {count > 0 ? (
              <div className="enter-row mt-4 shrink-0 space-y-2">
                <Button
                  fullWidth
                  disabled={!canPay}
                  onClick={() => router.push(`/s/${merchant.npub}/checkout`)}
                >
                  <Zap className="size-4" aria-hidden />
                  Pagar con Lightning
                </Button>
                <Button fullWidth variant="ghost" size="sm" onClick={clear}>
                  Vaciar
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

/**
 * What an empty order says, which depends on why it is empty.
 *
 * Telling someone to tap a `+` when the shop has published nothing is advice
 * they cannot follow — the storefront beside this panel is showing its own
 * "todavía no publicó productos" at that moment. And neither message is true
 * while the catalog is still in flight, which is why loading is its own state
 * rather than a guess at one of the other two.
 */
function EmptyHint({ state }: { state: "loading" | "no-products" | "empty" }) {
  if (state === "loading") {
    return (
      <p
        aria-live="polite"
        className="flex items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        Cargando el catálogo…
      </p>
    )
  }

  if (state === "no-products") {
    return (
      <p className="enter-pop py-6 text-center text-sm text-muted-foreground">
        Esta tienda todavía no tiene productos para agregar.
      </p>
    )
  }

  return (
    <p className="enter-pop py-6 text-center text-sm text-muted-foreground">
      Tocá el <span className="text-primary">+</span> de un producto para
      empezar.
    </p>
  )
}
