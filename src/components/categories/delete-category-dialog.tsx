"use client"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { Category } from "@/lib/domain/category"

/**
 * Deleting a category is never a single event, so the buttons state the exact
 * number of signatures up front: with a remote signer each one is a separate
 * approval on the merchant's phone, and being surprised by six prompts is how
 * people abandon a half-finished delete.
 *
 * "Orphan" republishes every member without this category's `t` tag and then
 * kind-5s the category itself — hence memberCount + 1 signatures.
 */
export function DeleteCategoryDialog({
  category,
  memberCount,
  onOpenChange,
  onConfirm,
}: {
  category: Category | null
  memberCount: number
  onOpenChange: (open: boolean) => void
  onConfirm: (mode: "orphan" | "delete") => void
}) {
  const one = memberCount === 1
  const productos = one ? "1 producto" : `${memberCount} productos`

  return (
    <AlertDialog open={category !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Eliminar «{category?.name}»?</AlertDialogTitle>
          <AlertDialogDescription>
            {memberCount === 0
              ? "La categoría está vacía. El cambio queda pendiente hasta que guardes."
              : `Tiene ${productos}. Elegí qué hacer con ${one ? "él" : "ellos"}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel>Cancelar</AlertDialogCancel>

          <Button variant="outline" onClick={() => onConfirm("orphan")}>
            {memberCount === 0
              ? "Eliminar"
              : `${one ? "Dejarlo" : "Dejarlos"} sin categoría`}
          </Button>

          {memberCount > 0 ? (
            <Button variant="destructive" onClick={() => onConfirm("delete")}>
              {one
                ? "Eliminar también el producto"
                : `Eliminar también los ${memberCount} productos`}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
