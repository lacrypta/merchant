"use client"

import { Loader2, Undo2, UploadCloud } from "lucide-react"
import * as React from "react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/**
 * The unsaved-changes bar.
 *
 * Sticks directly under the navbar rather than floating at the bottom: the
 * publish monitor already owns the bottom-right corner at z-50, and stacking
 * two competing "something is happening" surfaces in one corner reads as a
 * bug. Under the header it also stays in view while the merchant scrolls a
 * long catalog, which is the whole point of a save affordance.
 *
 * It announces the SIGNATURE count, not the change count. With a NIP-46
 * signer each event is a separate approval tap on the merchant's phone, and
 * finding that out after tap three is a bad surprise — a deletion alone costs
 * two (a kind 5 plus a tombstone).
 */
export function UnsavedBar() {
  const { changes, saveChanges, discardChanges, saving } = useCatalog()
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  if (changes.count === 0 && !saving) return null

  const { count, signatures } = changes
  const items = count === 1 ? "1 cambio" : `${count} cambios`
  const sigs = signatures === 1 ? "1 firma" : `${signatures} firmas`

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="enter-row sticky top-16 z-30 -mx-4 mb-6 border-b border-warning/30 bg-warning-bg/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6"
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-warning">
            <b className="numeric font-semibold">{items}</b> sin publicar
            {count > 0 ? (
              <>
                <span aria-hidden> · </span>
                <span className="numeric">{sigs}</span>
              </>
            ) : null}
          </p>

          <Button
            variant="ghost"
            size="sm"
            disabled={saving || count === 0}
            onClick={() => setConfirmDiscard(true)}
          >
            <Undo2 className="size-4" aria-hidden />
            Descartar
          </Button>

          <Button size="sm" disabled={saving || count === 0} onClick={saveChanges}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Publicando…
              </>
            ) : (
              <>
                <UploadCloud className="size-4" aria-hidden />
                Guardar cambios
              </>
            )}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar {items}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tu catálogo vuelve a como está publicado en los relays. Esto no se
              puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction
              onClick={discardChanges}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
