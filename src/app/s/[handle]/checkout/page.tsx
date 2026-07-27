import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { CheckoutScreen } from "@/components/checkout/checkout-screen"
import { Button } from "@/components/ui/button"
import { getStorefront, toMerchantSummary } from "@/lib/server/storefront"

export const runtime = "nodejs"
export const revalidate = 60

export const metadata: Metadata = {
  title: "Pagar",
  // A checkout page is per-visitor and worthless in an index.
  robots: { index: false, follow: false },
}

/**
 * A thin server shell around a client screen.
 *
 * The order lives entirely in the visitor's browser — there is no order table,
 * no webhook, no server record — so the server's only jobs are resolving the
 * merchant (deduped with the layout via getStorefront) and refusing early when
 * the merchant cannot be paid at all.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const data = await getStorefront(decodeURIComponent(handle))
  if (!data) notFound()

  const merchant = toMerchantSummary(data.resolved, data.store)

  if (!merchant.canCheckout) {
    return (
      <main id="main" className="mx-auto w-full max-w-form flex-1 px-4 py-16">
        <div className="rounded-2xl border border-warning/30 bg-warning-bg px-5 py-6 text-center">
          <h1 className="text-h2 mb-2 text-warning">Todavía no se puede pagar acá</h1>
          <p className="mb-5 text-sm text-warning">
            {merchant.displayName} no configuró una dirección Lightning en su
            perfil de nostr.
          </p>
          <Button variant="outline" asChild>
            <Link href={`/s/${merchant.npub}`}>Volver a la tienda</Link>
          </Button>
        </div>
      </main>
    )
  }

  return <CheckoutScreen />
}
