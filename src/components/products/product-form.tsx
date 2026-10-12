"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { useCoupons } from "@/components/coupons/use-coupons"
import { ProductImageUpload } from "@/components/products/product-image-upload"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SegmentedControl } from "@/components/ui/segmented-control"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { describeBenefit, type ProductCoupon } from "@/lib/domain/coupon"
import { CURRENCIES, formatPrice, type Currency } from "@/lib/domain/price"
import { productFormSchema } from "@/lib/domain/product-schema"
import { slugify } from "@/lib/domain/slug"
import {
  isSkuTaken,
  normalizeSku,
  MAX_SKU_LENGTH,
  type Product,
  type ProductImage,
  type Visibility,
} from "@/lib/domain/product"
import { cn } from "@/lib/utils"

type FieldErrors = Partial<Record<string, string>>

function emptyProduct(pubkey: string): Product {
  return {
    d: crypto.randomUUID(),
    posId: 0,
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
  const { categories, products, saveProduct } = useCatalog()

  const base = React.useMemo(
    () => existing ?? emptyProduct(pubkey),
    [existing, pubkey]
  )

  const [title, setTitle] = React.useState(base.title)
  const [sku, setSku] = React.useState(base.sku ?? "")
  /**
   * While creating, the SKU follows the name ("Fernet con Coca" →
   * "fernet-con-coca") until the merchant types one of their own. Never on an
   * edit: the SKU is the join key with WooCommerce, and renaming a product
   * must not silently re-key it.
   */
  const [skuTouched, setSkuTouched] = React.useState(!!existing)
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
  const [isCoupon, setIsCoupon] = React.useState(!!base.coupon)
  const [coupon, setCoupon] = React.useState<ProductCoupon | null>(base.coupon ?? null)
  const [maxQty, setMaxQty] = React.useState(base.maxQty ? String(base.maxQty) : "")
  const [selected, setSelected] = React.useState<string[]>(() =>
    base.categories.length > 0
      ? base.categories
      : defaultCategory
        ? [defaultCategory]
        : []
  )
  const [image, setImage] = React.useState<ProductImage | null>(
    base.images[0] ?? null
  )
  const [uploadingImage, setUploadingImage] = React.useState(false)
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [saving, setSaving] = React.useState(false)

  const numericAmount = Number(amount.replace(",", "."))

  function toggleCategory(slug: string) {
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    )
  }

  function submit() {
    if (uploadingImage) {
      setErrors((current) => ({
        ...current,
        form: "Esperá a que termine de subir la imagen.",
      }))
      return
    }

    const cleanSku = normalizeSku(sku)
    if (cleanSku && isSkuTaken(cleanSku, products, base.d)) {
      // Not a zod refine: uniqueness needs the whole catalog, which the
      // schema cannot see.
      setErrors({ sku: "Ya hay otro producto con ese SKU." })
      return
    }

    const parsed = productFormSchema.safeParse({
      title,
      sku,
      summary: undefined,
      description,
      // A coupon product is never charged for: it only switches its coupon on.
      amount: isCoupon ? 0 : Number.isFinite(numericAmount) ? numericAmount : undefined,
      currency,
      trackStock,
      stock: trackStock ? Number(stock) : null,
      visibility,
      status: "active" as const,
      categories: selected,
      couponId: isCoupon ? (coupon?.id ?? "") : "",
      maxQty: isCoupon && maxQty.trim() ? Number(maxQty) : null,
      imageUrl: image?.url ?? "",
    })

    if (isCoupon && !coupon) {
      setErrors({ coupon: "Elegí el cupón que aplica." })
      return
    }

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
    setSaving(true)

    const v = parsed.data
    const product: Product = {
      ...base,
      status: v.status,
      title: v.title,
      sku: cleanSku,
      summary: base.summary,
      description: v.description,
      price: { amount: v.amount, currency: v.currency },
      stock: v.trackStock ? v.stock : null,
      visibility: v.visibility,
      categories: v.categories,
      images: v.imageUrl && image ? [{ ...image, order: 0 }] : [],
      coupon: isCoupon && coupon ? coupon : undefined,
      maxQty: v.maxQty ?? undefined,
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
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="grid gap-8 md:grid-cols-[minmax(0,1fr)_auto]"
      noValidate
    >
      {/* Opaque, not translucent. A blurred 85% bar works over a page — that
          is the navbar — but over a form it lets the field you are scrolling
          past read straight through the button, which looks like the content
          is passing over the bar rather than under it. */}
      <div className="sticky top-0 z-20 col-span-full -mx-4 flex min-h-16 items-center justify-end border-b border-border bg-popover px-4 py-2">
        <Button type="submit" disabled={saving || uploadingImage}>
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Firmando…
            </>
          ) : uploadingImage ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Subiendo imagen…
            </>
          ) : existing ? (
            "Guardar cambios"
          ) : (
            "Publicar"
          )}
        </Button>
      </div>

      <div className="space-y-6">
        <Field label="Nombre" error={errors.title} htmlFor="p-title" required>
          <Input
            id="p-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              if (!skuTouched) setSku(slugify(e.target.value))
            }}
            placeholder="Fernet con Coca"
            aria-invalid={!!errors.title}
            maxLength={120}
          />
        </Field>

        <Field
          label="SKU"
          error={errors.sku}
          htmlFor="p-sku"
          hint="Se genera a partir del nombre. La referencia que comparte con WooCommerce u otro sistema."
        >
          <Input
            id="p-sku"
            value={sku}
            onChange={(e) => {
              setSku(e.target.value)
              setSkuTouched(true)
            }}
            placeholder="fernet-con-coca"
            autoComplete="off"
            aria-invalid={!!errors.sku}
            maxLength={MAX_SKU_LENGTH}
            className="numeric"
          />
        </Field>

        {existing && !isCoupon ? null : (
          <div className="space-y-3">
            {/* The type is picked once, when the product is created. */}
            {existing ? null : (
              <>
                <Label>Tipo</Label>
                <SegmentedControl
                  aria-label="Tipo de producto"
                  value={isCoupon ? "coupon" : "normal"}
                  onValueChange={(v) => setIsCoupon(v === "coupon")}
                  options={[
                    { value: "normal", label: "Normal" },
                    { value: "coupon", label: "Cupón" },
                  ]}
                />
              </>
            )}
            {isCoupon ? (
              <>
                <CouponPicker value={coupon} onChange={setCoupon} error={errors.coupon} />
                <Field
                  label="Máximo por compra"
                  error={errors.maxQty}
                  htmlFor="p-max-qty"
                  hint="Cuántas unidades puede llevar una misma compra. Vacío: sin límite."
                >
                  <Input
                    id="p-max-qty"
                    value={maxQty}
                    onChange={(e) => setMaxQty(e.target.value)}
                    inputMode="numeric"
                    placeholder="1"
                    className="numeric max-w-40"
                    aria-invalid={!!errors.maxQty}
                  />
                </Field>
              </>
            ) : null}
          </div>
        )}

        {isCoupon ? null : (
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
        )}

        <Field label="Descripción" htmlFor="p-desc">
          <Textarea
            id="p-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Se admite Markdown."
          />
        </Field>

        {/* Mobile only: from md up the uploader lives in the preview card. */}
        <div className="space-y-2 md:hidden">
          <Label>Imagen</Label>
          <ProductImageUpload
            value={image}
            onChange={(nextImage) => {
              setImage(nextImage)
              setErrors((current) => ({
                ...current,
                imageUrl: undefined,
              }))
            }}
            onBusyChange={setUploadingImage}
            validationError={errors.imageUrl}
          />
        </div>

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

      </div>

      <aside className="hidden md:block">
        <div className="sticky top-24 space-y-3">
          <p className="text-sm text-muted-foreground">Así se va a ver</p>
          <article className="w-[200px] overflow-hidden rounded-xl border border-border bg-card">
            <ProductImageUpload
              compact
              value={image}
              onChange={(nextImage) => {
                setImage(nextImage)
                setErrors((current) => ({ ...current, imageUrl: undefined }))
              }}
              onBusyChange={setUploadingImage}
              validationError={errors.imageUrl}
            />
            <div className="space-y-1 p-3">
              <p className="line-clamp-2 text-sm leading-tight font-semibold">
                {title || "Nombre del producto"}
              </p>
              {base.summary ? (
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {base.summary}
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

/**
 * The cupones libres this product may carry.
 *
 * Its own component so the coupon list — a signed request — is only fetched
 * once the merchant actually picks "Cupón", not every time a product opens.
 *
 * Re-syncs the snapshot to the coupon's CURRENT terms whenever the list loads,
 * so re-saving a coupon product is also how it picks up an edited coupon.
 */
function CouponPicker({
  value,
  onChange,
  error,
}: {
  value: ProductCoupon | null
  onChange: (c: ProductCoupon | null) => void
  error?: string
}) {
  const { coupons, loading } = useCoupons()
  const { products } = useCatalog()
  const open = coupons.filter((c) => c.open && c.benefit && c.archivedAt === null)
  const titleOf = (d: string) => products.find((p) => p.d === d)?.title

  const current = open.find((c) => c.id === value?.id)
  React.useEffect(() => {
    if (!current?.benefit) return
    const fresh = { id: current.id, name: current.name, benefit: current.benefit }
    if (JSON.stringify(fresh) !== JSON.stringify(value)) onChange(fresh)
  }, [current, value, onChange])

  return (
    <Field
      label="Cupón"
      error={error}
      hint={
        current?.benefit
          ? describeBenefit(current.benefit, titleOf)
          : loading
            ? "Cargando cupones…"
            : open.length === 0
              ? "No tenés cupones libres. Creá uno en Cupones con la opción \"Cupón libre\"."
              : "Al llevar este producto, se aplica este cupón a la compra."
      }
      required
    >
      <Select
        value={value?.id ?? ""}
        onValueChange={(id) => {
          const c = open.find((x) => x.id === id)
          onChange(c?.benefit ? { id: c.id, name: c.name, benefit: c.benefit } : null)
        }}
      >
        <SelectTrigger className="w-full" aria-invalid={!!error}>
          <SelectValue placeholder={value?.name ?? "Elegí un cupón libre"} />
        </SelectTrigger>
        <SelectContent>
          {open.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
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
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
