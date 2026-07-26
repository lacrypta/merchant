"use client"

import Link from "next/link"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { EmptyState } from "@/components/feedback/empty-state"
import { ProductForm } from "@/components/products/product-form"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/** `d` absent => create. `d` present => edit that product. */
export function ProductEditor({ d }: { d?: string }) {
  const { state } = useAuth()
  const { loading, products } = useCatalog()

  if (state.status !== "ready") return null

  if (d && loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    )
  }

  const existing = d ? products.find((p) => p.d === d) : undefined

  // Only a genuine 404 once loading has finished — otherwise a slow relay
  // would look like a missing product.
  if (d && !existing) {
    return (
      <EmptyState
        title="No encontramos ese producto"
        description="Puede que lo hayas eliminado desde otro dispositivo."
        action={
          <Button asChild>
            <Link href="/products">Volver a productos</Link>
          </Button>
        }
      />
    )
  }

  return (
    <>
      <PageHeader title={existing ? "Editar producto" : "Nuevo producto"} />
      <ProductForm pubkey={state.pubkey} existing={existing} />
    </>
  )
}
