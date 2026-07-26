"use client"

import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { ProductForm } from "@/components/products/product-form"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import type { Product } from "@/lib/domain/product"

/**
 * Create / edit a product, in place on the catalog.
 *
 * A dialog rather than its own route: the merchant is working through a list,
 * and a full navigation loses their scroll position and filter for what is a
 * short form. Since publishing is queued in the background, closing is
 * instant — there is nothing to wait for.
 */
export function ProductDialog({
  open,
  existing,
  defaultCategory,
  onOpenChange,
}: {
  open: boolean
  /** undefined = create. */
  existing?: Product
  /** Preselected category slug when creating from an empty group. */
  defaultCategory?: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { state } = useAuth()
  if (state.status !== "ready") return null

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {existing ? "Editar producto" : "Nuevo producto"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Se publica en nostr firmado con tu npub.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Keyed so switching which product is being edited resets the fields
            by remounting, instead of a setState-in-effect. */}
        {open ? (
          <ProductForm
            key={existing?.d ?? `new:${defaultCategory ?? ""}`}
            pubkey={state.pubkey}
            existing={existing}
            defaultCategory={defaultCategory}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
