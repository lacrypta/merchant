"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import type { Category } from "@/lib/domain/category"
import { slugify } from "@/lib/domain/slug"

const EMOJI_CHOICES = [
  "\ud83c\udf79","\ud83c\udf7a","\ud83e\udd64","\u2615","\ud83c\udf55","\ud83c\udf54","\ud83c\udf2d","\ud83e\udd6a","\ud83c\udf5f","\ud83c\udf70",
  "\ud83e\uddc9","\ud83c\udf77","\ud83e\udd5f","\ud83c\udf2e","\ud83c\udf6b","\ud83e\uddca","\ud83d\udc55","\ud83e\udde2","\ud83d\udcd5","\ud83d\udd11",
  "\u26a1","\ud83c\udf9f\ufe0f","\ud83c\udf81","\ud83d\udee0\ufe0f","\ud83d\udcbe","\ud83d\uddbc\ufe0f","\ud83e\ude99","\ud83d\udce6",
]

function CategoryForm({
  existing,
  nextOrder,
  onOpenChange,
  onSave,
}: {
  existing: Category | null
  nextOrder: number
  onOpenChange: (open: boolean) => void
  onSave: (c: Category) => void
}) {
  // Initialised from props and reset by REMOUNTING (see the key on
  // <CategoryForm> below) rather than by a setState-in-effect, which would
  // cascade a render every time the dialog opens.
  const [name, setName] = React.useState(existing?.name ?? "")
  const [emoji, setEmoji] = React.useState<string | undefined>(existing?.emoji)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  function submit() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Poné un nombre")
      return
    }
    const slug = existing?.slug ?? slugify(trimmed)
    if (!slug) {
      setError("Ese nombre no genera un identificador válido")
      return
    }

    setSaving(true)
    try {
      onSave({
        d: existing?.d ?? crypto.randomUUID(),
        posId: 0,
        name: trimmed,
        slug,
        emoji,
        summary: existing?.summary,
        image: existing?.image,
        order: existing?.order ?? nextOrder,
        productDs: existing?.productDs ?? [],
        eventId: existing?.eventId ?? "",
        updatedAt: existing?.updatedAt ?? 0,
        unknownTags: existing?.unknownTags ?? [],
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pudimos guardar.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {existing ? "Editar categoría" : "Nueva categoría"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Se publica como un evento kind 30405 firmado con tu npub.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="c-name">Nombre</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bebidas"
              aria-invalid={!!error}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
            />
            {existing ? (
              <p className="text-xs text-muted-foreground">
                El identificador <code>{existing.slug}</code> no se puede
                cambiar: los productos lo referencian por su tag <code>t</code>.
              </p>
            ) : name.trim() ? (
              <p className="text-xs text-muted-foreground">
                Identificador: <code>{slugify(name)}</code>
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>Emoji</Label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setEmoji(undefined)}
                aria-pressed={emoji === undefined}
                className={`size-9 rounded-lg border text-sm ${
                  emoji === undefined
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border-strong text-muted-foreground"
                }`}
              >
                —
              </button>
              {EMOJI_CHOICES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  aria-pressed={emoji === e}
                  aria-label={`Emoji ${e}`}
                  className={`size-9 rounded-lg border text-lg ${
                    emoji === e
                      ? "border-primary bg-primary/20"
                      : "border-border hover:border-border-strong"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex gap-3">
            <Button onClick={() => submit()} disabled={saving}>
              {saving ? "Firmando…" : existing ? "Guardar" : "Crear"}
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          </div>
        </div>
    </>
  )
}

export function CategoryDialog(props: {
  open: boolean
  existing: Category | null
  nextOrder: number
  onOpenChange: (open: boolean) => void
  onSave: (c: Category) => void
}) {
  return (
    <ResponsiveDialog open={props.open} onOpenChange={props.onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {/* key remounts the form, which is how its fields reset. */}
        {props.open ? (
          <CategoryForm key={props.existing?.d ?? "new"} {...props} />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
