"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { CURRENCIES, formatPrice, type Currency } from "@/lib/domain/price"
import { productFormSchema } from "@/lib/domain/product-schema"
import type { Product, Visibility } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

type FieldErrors = Partial<Record<string, string>>

function emptyProduct(pubkey: string): Product {
  return {
    d: crypto.randomUUID(),
    posId: 0,
    lifecycle: "published",
    status: "active",
    title: "",
    summary: undefined,
    description: "",
    price: { amount: 0, currency: "ARS" },
    stock: null,
    visibility: "on-sale",
    type: { kind: "simple", format: "physical" },
    categories: [],
    images: [],
    publishedAt: 0,
    updatedAt: 0,
    eventId: "",
    pubkey,
    unknownTags: [],
  }
}

export function ProductForm({
  pubkey,
  existing,
  defaultCategory,
  onDone,
}: {
  pubkey: string
  existing?: Product
  defaultCategory?: string | null
  /** Called once the write is queued — the dialog closes on this. */
  onDone: () => void
}) {
  const { categories, saveProduct } = useCatalog()

  const base = React.useMemo(
    () => existing ?? emptyProduct(pubkey),
    [existing, pubkey]
  )

  const [title, setTitle] = React.useState(base.title)
  const [summary, setSummary] = React.useState(base.summary ?? "")
  const [description, setDescription] = React.useState(base.description)
  const [amount, setAmount] = React.useState(
    base.price ? String(base.price.amount) : ""
  )
  const [currency, setCurrency] = React.useState<Currency>(
    (base.price?.currency as Currency) ?? "ARS"
  )
  const [trackStock, setTrackStock] = React.useState(base.stock !== null)
  const [stock, setStock] = React.useState(
    base.stock !== null ? String(base.stock) : ""
  )
  const [visibility, setVisibility] = React.useState<Visibility>(base.visibility)
  const [selected, setSelected] = React.useState<string[]>(() =>
    base.categories.length > 0
      ? base.categories
      : defaultCategory
        ? [defaultCategory]
        : []
  )
  const [imageUrl, setImageUrl] = React.useState(base.images[0]?.url ?? "")
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [saving, setSaving] = React.useState<null | "draft" | "publish">(null)

  const numericAmount = Number(amount.replace(",", "."))

  function toggleCategory(slug: string) {
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    )
  }

  function submit(lifecycle: "published" | "draft") {
    const parsed = productFormSchema.safeParse({
      title,
      summary: summary || undefined,
      description,
      amount: Number.isFinite(numericAmount) ? numericAmount : undefined,
      currency,
      trackStock,
      stock: trackStock ? Number(stock) : null,
      visibility,
      status: "active" as const,
      categories: selected,
      imageUrl: imageUrl || "",
    })

    if (!parsed.success) {
      const next: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form")
        next[key] ??= issue.message
      }
      setErrors(next)
      return
    }

    setErrors({})
    setSaving(lifecycle === "draft" ? "draft" : "publish")

    const v = parsed.data
    const product: Product = {
      ...base,
      lifecycle,
      status: v.status,
      title: v.title,
      summary: v.summary,
      description: v.description,
      price: { amount: v.amount, currency: v.currency },
      stock: v.trackStock ? v.stock : null,
      visibility: v.visibility,
      categories: v.categories,
      images: v.imageUrl
        ? [{ url: v.imageUrl, width: 256, height: 256, order: 0 }]
        : [],
      pubkey,
    }

    try {
      // Fire-and-forget: saveProduct applies the change locally and hands the
      // event to the background queue, so the dialog can close immediately.
      // Publish progress lives in the monitor, not here.
      saveProduct(product)
      onDone()
    } catch (e) {
      setErrors({
        form: e instanceof Error ? e.message : "No pudimos guardar el producto.",
      })
      setSaving(null)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit("published")
      }}
      className="grid gap-8 md:grid-cols-[minmax(0,1fr)_auto]"
      noValidate
    >
      <div className="space-y-6">
        <Field label="Nombre" error={errors.title} htmlFor="p-title" required>
          <Input
            id="p-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Fernet con Coca"
            aria-invalid={!!errors.title}
            maxLength={120}
          />
        </Field>

        <Field label="Bajada" error={errors.summary} htmlFor="p-summary">
          <Input
            id="p-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Vaso de 500ml"
            maxLength={200}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Precio" error={errors.amount} htmlFor="p-amount" required>
            <Input
              id="p-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="7300"
              aria-invalid={!!errors.amount}
              className="numeric"
            />
          </Field>
          <SegmentedControl
            aria-label="Moneda"
            value={currency}
            onValueChange={(v) => setCurrency(v as Currency)}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </div>

        <Field label="Descripción" htmlFor="p-desc">
          <Textarea
            id="p-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Se admite Markdown."
          />
        </Field>

        <Field label="Imagen (URL)" error={errors.imageUrl} htmlFor="p-img">
          <Input
            id="p-img"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://blossom.band/…"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={!!errors.imageUrl}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            La subida con recorte a Blossom llega en el próximo paso; por ahora
            pegá una URL.
          </p>
        </Field>

        <div className="space-y-3">
          <Label>Categorías</Label>
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todavía no creaste ninguna. Podés publicar el producto igual y
              asignarla después.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => {
                const on = selected.includes(c.slug)
                const isPrimary = selected[0] === c.slug
                return (
                  <button
                    key={c.d}
                    type="button"
                    onClick={() => toggleCategory(c.slug)}
                    aria-pressed={on}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border-strong text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {c.emoji ? <span aria-hidden>{c.emoji}</span> : null}
                    {c.name}
                    {isPrimary && selected.length > 1 ? (
                      <span className="text-[0.625rem] opacity-70">POS</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
          {selected.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              La primera que elegiste es la que ve el POS.
            </p>
          ) : null}
          {errors.categories ? (
            <p role="alert" className="text-sm text-danger">
              {errors.categories}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={!trackStock}
              onCheckedChange={(v) => setTrackStock(!v)}
            />
            Stock ilimitado
          </label>
          {trackStock ? (
            <Field label="Cantidad" error={errors.stock} htmlFor="p-stock">
              <Input
                id="p-stock"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                inputMode="numeric"
                className="numeric max-w-40"
                aria-invalid={!!errors.stock}
              />
            </Field>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Visibilidad</Label>
          <SegmentedControl
            aria-label="Visibilidad"
            value={visibility}
            onValueChange={(v) => setVisibility(v as Visibility)}
            options={[
              { value: "on-sale", label: "A la venta" },
              { value: "pre-order", label: "Pre-venta" },
              { value: "hidden", label: "Oculto" },
            ]}
          />
        </div>

        {errors.form ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {errors.form}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={saving !== null}>
            {saving === "publish" ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Firmando…
              </>
            ) : existing ? (
              "Guardar cambios"
            ) : (
              "Publicar"
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving !== null}
            onClick={() => submit("draft")}
          >
            {saving === "draft" ? "Guardando…" : "Guardar borrador"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
        </div>
      </div>

      <aside className="hidden md:block">
        <div className="sticky top-24 space-y-3">
          <p className="text-sm text-muted-foreground">Así se va a ver</p>
          <article className="w-[200px] overflow-hidden rounded-xl border border-border bg-card">
            <div className="relative aspect-square bg-surface-3">
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                <div aria-hidden className="grid-flat size-full opacity-40" />
              )}
            </div>
            <div className="space-y-1 p-3">
              <p className="line-clamp-2 text-sm leading-tight font-semibold">
                {title || "Nombre del producto"}
              </p>
              {summary ? (
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {summary}
                </p>
              ) : null}
              <p className="numeric text-price text-primary">
                {Number.isFinite(numericAmount) && numericAmount > 0
                  ? formatPrice(numericAmount, currency)
                  : formatPrice(0, currency)}
              </p>
            </div>
          </article>
        </div>
      </aside>
    </form>
  )
}

function Field({
  label,
  htmlFor,
  error,
  required,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
