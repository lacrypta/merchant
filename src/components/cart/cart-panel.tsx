"use client"

import { Zap } from "lucide-react"
import { useRouter } from "next/navigation"

import { CartContents, useCanPay } from "@/components/cart/cart-contents"
import { useCart } from "@/components/cart/cart-provider"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useIsDesktop } from "@/hooks/use-media-query"

/**
 * The cart as an overlay — phones and tablets only.
 *
 * Above 1024px the sidebar in <CartAside> is always on screen, so this would
 * be a modal covering a panel that already shows the same thing. The guard
 * uses the SAME breakpoint hook ResponsiveDialog uses to pick Dialog vs
 * Drawer, so the two can never disagree about where the boundary is.
 *
 * ResponsiveDialog rather than Sheet: it is the house pattern, and its footer
 * already applies `.safe-b` — which matters because the footer holds the pay
 * button and an iOS home indicator will happily eat that tap.
 */
export function CartPanel() {
  const { merchant, count, panelOpen, setPanelOpen, clear } = useCart()
  const isDesktop = useIsDesktop()
  const router = useRouter()
  const canPay = useCanPay()

  if (isDesktop) return null

  return (
    <ResponsiveDialog open={panelOpen} onOpenChange={setPanelOpen}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Tu pedido</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {count === 0
              ? "Todavía no agregaste nada."
              : `${count} ${count === 1 ? "producto" : "productos"} de ${merchant.displayName}.`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <CartContents />

        <ResponsiveDialogFooter className="mt-6 flex-row gap-2">
          {count > 0 ? (
            <>
              <Button variant="ghost" onClick={clear}>
                Vaciar
              </Button>
              <Button
                fullWidth
                disabled={!canPay}
                onClick={() => {
                  setPanelOpen(false)
                  router.push(`/s/${merchant.npub}/checkout`)
                }}
              >
                <Zap className="size-4" aria-hidden />
                Pagar con Lightning
              </Button>
            </>
          ) : (
            <Button fullWidth variant="outline" onClick={() => setPanelOpen(false)}>
              Seguir mirando
            </Button>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
