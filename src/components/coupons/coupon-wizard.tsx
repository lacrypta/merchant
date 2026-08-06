"use client"

import {
  ArrowLeft,
  ArrowRight,
  BadgePercent,
  Check,
  Coins,
  Gift,
  Layers,
  Loader2,
  Minus,
  PackageOpen,
  Plus,
  TicketPercent,
  X,
} from "lucide-react"
import * as React from "react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import type { CouponInput, CouponJson } from "@/components/coupons/use-coupons"
import { ProductScopePicker } from "@/components/coupons/product-scope-picker"
import { ProductImageUpload } from "@/components/products/product-image-upload"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  describeBenefit,
  MAX_FREE_QTY,
  type CouponType,
  type FreeUnits,
} from "@/lib/domain/coupon"
import {
  benefitFromForm,
  couponFormSchema,
  formValuesFromBenefit,
  type CouponFormOutput,
} from "@/lib/domain/coupon-schema"
import { CURRENCIES, type Currency } from "@/lib/domain/price"
import type { ProductImage } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

/**
 * Create or edit a coupon, as three steps.
 *
 * Split this way because the three questions are independent and only the first
 * one is a real decision: what the coupon takes off the bill, then how the
 * customer reads it, then how many exist. A single tall form asked all of that
 * at once and buried the choice that matters in the middle of it.
 *
 * Steps are navigable in any order rather than locked behind validation —
 * nothing here is destructive, and a merchant who wants to set the expiry date
 * first should be allowed to. Validation runs on submit and points at the step
 * that needs attention.
 */

type FieldErrors = Partial<Record<string, string>>

type StepId = "benefit" | "presentation" | "limits"

interface Step {
  id: StepId
  title: string
  hint: string
  /** Which schema fields belong to this step, for the error badges. */
  fields: readonly string[]
}

const STEPS: readonly Step[] = [
  {
    id: "benefit",
    title: "Descuento",
    hint: "Qué le saca al total",
    fields: [
      "type",
      "percent",
      "amount",
      "currency",
      "buyQty",
      "payQty",
      "productDs",
      "buyProductD",
      "giftProductD",
      "freeItems",
    ],
  },
  {
    id: "presentation",
    title: "Presentación",
    hint: "Cómo lo ve tu cliente",
    fields: ["name", "description", "imageUrl"],
  },
  {
    id: "limits",
    title: "Límites",
    hint: "Cuántos y hasta cuándo",
    fields: ["maxUses", "expiresAt"],
  },
] as const

const TYPES: {
  value: CouponType
  label: string
  example: string
  icon: typeof BadgePercent
}[] = [
  { value: "percent", label: "Porcentaje", example: "10% en todo", icon: BadgePercent },
  { value: "fixed", label: "Monto fijo", example: "ARS 500 menos", icon: Coins },
  { value: "multibuy", label: "NxM", example: "2x1, 3x2", icon: Layers },
  { value: "buyXgetY", label: "Regalo", example: "Comprá uno, llevate otro", icon: Gift },
  {
    value: "freeItems",
    label: "Producto gratis",
    example: "2 cafés, sin comprar nada",
    icon: PackageOpen,
  },
]

/** Unix seconds ⇄ the `yyyy-mm-dd` an `<input type="date">` speaks. */
function toDateInput(unixSeconds: number | null): string {
  if (!unixSeconds) return ""
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * End of the chosen day, LOCAL time.
 *
 * A merchant who types 31/12 means "válido todo el 31", not "hasta las 00:00
 * del 31" — which is what parsing the bare date as UTC midnight would give
 * them, expiring the coupon a day early for anyone west of Greenwich.
 */
function fromDateInput(value: string): number | null {
  if (!value) return null
  const [y, m, d] = value.split("-").map(Number)
  if (!y || !m || !d) return null
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000)
}

export function CouponWizard({
  existing,
  onSubmit,
  onCancel,
}: {
  existing?: CouponJson
  onSubmit: (input: CouponInput) => Promise<void>
  onCancel: () => void
}) {
  const { products } = useCatalog()

  const initial = React.useMemo(
    () =>
      formValuesFromBenefit(
        existing?.benefit ?? { type: "percent", percent: 10 }
      ),
    [existing]
  )

  const [step, setStep] = React.useState<StepId>("benefit")
  const [name, setName] = React.useState(existing?.name ?? "")
  const [description, setDescription] = React.useState(existing?.description ?? "")
  const [image, setImage] = React.useState<ProductImage | null>(
    existing?.image ? { url: existing.image, width: 0, height: 0, order: 0 } : null
  )
  const [uploading, setUploading] = React.useState(false)
  const [type, setType] = React.useState<CouponType>(initial.type)
  const [percent, setPercent] = React.useState(
    initial.percent === null ? "10" : String(initial.percent)
  )
  const [amount, setAmount] = React.useState(
    initial.amount === null ? "" : String(initial.amount)
  )
  const [currency, setCurrency] = React.useState<Currency>(initial.currency as Currency)
  const [buyQty, setBuyQty] = React.useState(
    initial.buyQty === null ? "2" : String(initial.buyQty)
  )
  const [payQty, setPayQty] = React.useState(
    initial.payQty === null ? "1" : String(initial.payQty)
  )
  const [productDs, setProductDs] = React.useState<string[]>(initial.productDs)
  const [buyProductD, setBuyProductD] = React.useState(initial.buyProductD)
  const [giftProductD, setGiftProductD] = React.useState(initial.giftProductD)
  const [freeItems, setFreeItems] = React.useState<FreeUnits[]>(initial.freeItems)
  const [limitUses, setLimitUses] = React.useState(existing?.maxUses != null)
  const [maxUses, setMaxUses] = React.useState(
    existing?.maxUses != null ? String(existing.maxUses) : "50"
  )
  const [expiresAt, setExpiresAt] = React.useState(toDateInput(existing?.expiresAt ?? null))

  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [saving, setSaving] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const num = (v: string): number | null => {
    const trimmed = v.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }

  const values: CouponFormOutput = {
    name,
    description,
    imageUrl: image?.url ?? "",
    type,
    percent: num(percent),
    amount: num(amount),
    currency,
    buyQty: num(buyQty),
    payQty: num(payQty),
    productDs,
    buyProductD,
    giftProductD,
    freeItems,
    maxUses: limitUses ? num(maxUses) : null,
    expiresAt,
  }

  const parsed = couponFormSchema.safeParse(values)
  const titleOf = React.useCallback(
    (d: string) => products.find((p) => p.d === d)?.title,
    [products]
  )
  /** The same sentence the customer will read. Null while the form is invalid. */
  const summary = parsed.success
    ? describeBenefit(benefitFromForm(parsed.data), titleOf)
    : null

  const index = STEPS.findIndex((s) => s.id === step)
  const isLast = index === STEPS.length - 1

  /** Only the steps the merchant already tried to submit show an error mark. */
  const stepHasError = (s: Step) => s.fields.some((f) => errors[f])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setServerError(null)

    const result = couponFormSchema.safeParse(values)
    if (!result.success) {
      const next: FieldErrors = {}
      for (const issue of result.error.issues) {
        const path = String(issue.path[0] ?? "")
        next[path] ??= issue.message
      }
      setErrors(next)
      // Land on the first step that actually needs work rather than leaving
      // them on a clean-looking page wondering why nothing happened.
      const broken = STEPS.find((s) => s.fields.some((f) => next[f]))
      if (broken) setStep(broken.id)
      return
    }

    setErrors({})
    setSaving(true)
    void (async () => {
      try {
        await onSubmit({
          name: result.data.name,
          description: result.data.description,
          image: result.data.imageUrl ? result.data.imageUrl : null,
          benefit: benefitFromForm(result.data),
          maxUses: result.data.maxUses,
          expiresAt: fromDateInput(result.data.expiresAt),
        })
      } catch (err) {
        setServerError(
          err instanceof Error ? err.message : "No pudimos guardar el cupón."
        )
      } finally {
        setSaving(false)
      }
    })()
  }

  const productOptions = products.map((p) => ({ d: p.d, title: p.title }))

  return (
    <form noValidate onSubmit={handleSubmit} className="flex min-h-0 flex-col">
      <Tabs value={step} onValueChange={(v) => setStep(v as StepId)}>
        <TabsList variant="line" className="h-auto w-full gap-0 p-0">
          {STEPS.map((s, i) => (
            <TabsTrigger
              key={s.id}
              value={s.id}
              className="h-auto flex-col items-start gap-1 px-3 py-3 text-left"
            >
              <span className="flex items-center gap-2">
                <StepNumber
                  index={i}
                  current={i === index}
                  done={i < index && !stepHasError(s)}
                  error={stepHasError(s)}
                />
                <span className="text-base font-semibold">{s.title}</span>
              </span>
              <span className="hidden text-xs font-normal text-muted-foreground sm:block">
                {s.hint}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <Progress
          value={((index + 1) / STEPS.length) * 100}
          className="mt-1"
          aria-label={`Paso ${index + 1} de ${STEPS.length}`}
        />

        {/* Each panel animates in, so moving between steps reads as movement
            rather than the content teleporting. */}
        <TabsContent
          value="benefit"
          className="space-y-6 pt-5 data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:slide-in-from-right-2"
        >
          <fieldset className="space-y-3">
            <legend className="text-base font-semibold">¿Qué tipo de descuento?</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {TYPES.map((t) => (
                <TypeCard
                  key={t.value}
                  {...t}
                  selected={type === t.value}
                  onSelect={() => setType(t.value)}
                />
              ))}
            </div>
          </fieldset>

          {type === "percent" ? (
            <div className="space-y-5">
              <Field label="Porcentaje" htmlFor="coupon-percent" error={errors.percent} required>
                <div className="flex items-center gap-3">
                  <Input
                    id="coupon-percent"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    className="numeric max-w-32 text-center text-2xl font-bold md:text-2xl"
                    value={percent}
                    onChange={(e) => setPercent(e.target.value)}
                    aria-invalid={!!errors.percent}
                  />
                  <span className="text-base text-muted-foreground">% de descuento</span>
                </div>
              </Field>
              <ScopeField
                value={productDs}
                onChange={setProductDs}
                products={productOptions}
                error={errors.productDs}
              />
            </div>
          ) : null}

          {type === "fixed" ? (
            <div className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
                <Field label="Monto" htmlFor="coupon-amount" error={errors.amount} required>
                  <Input
                    id="coupon-amount"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    className="numeric text-2xl font-bold md:text-2xl"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="500"
                    aria-invalid={!!errors.amount}
                  />
                </Field>
                <Field label="Moneda" error={errors.currency}>
                  <SegmentedControl
                    value={currency}
                    onValueChange={(v) => setCurrency(v as Currency)}
                    options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                    aria-label="Moneda"
                  />
                </Field>
              </div>
              <ScopeField
                value={productDs}
                onChange={setProductDs}
                products={productOptions}
                error={errors.productDs}
                hint="Con productos elegidos, el descuento nunca supera lo que valen esos productos en el carrito."
              />
            </div>
          ) : null}

          {type === "multibuy" ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Se lleva" htmlFor="coupon-buy-qty" error={errors.buyQty} required>
                  <Input
                    id="coupon-buy-qty"
                    type="number"
                    inputMode="numeric"
                    min={2}
                    className="numeric text-center text-2xl font-bold md:text-2xl"
                    value={buyQty}
                    onChange={(e) => setBuyQty(e.target.value)}
                    aria-invalid={!!errors.buyQty}
                  />
                </Field>
                <Field label="Paga" htmlFor="coupon-pay-qty" error={errors.payQty} required>
                  <Input
                    id="coupon-pay-qty"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    className="numeric text-center text-2xl font-bold md:text-2xl"
                    value={payQty}
                    onChange={(e) => setPayQty(e.target.value)}
                    aria-invalid={!!errors.payQty}
                  />
                </Field>
              </div>
              <ScopeField
                value={productDs}
                onChange={setProductDs}
                products={productOptions}
                error={errors.productDs}
                hint="El 2x1 se cuenta por producto: con varios elegidos, cada uno suma por su cuenta."
              />
            </div>
          ) : null}

          {type === "buyXgetY" ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Comprando"
                error={errors.buyProductD}
                required
                hint={
                  productOptions.length === 0
                    ? "Primero cargá productos en el catálogo."
                    : undefined
                }
              >
                <ProductSelect
                  value={buyProductD}
                  onChange={setBuyProductD}
                  options={productOptions}
                  placeholder="Elegí un producto"
                />
              </Field>
              <Field label="Se lleva gratis" error={errors.giftProductD} required>
                <ProductSelect
                  value={giftProductD}
                  onChange={setGiftProductD}
                  options={productOptions}
                  placeholder="Elegí un producto"
                />
              </Field>
            </div>
          ) : null}

          {type === "freeItems" ? (
            <FreeItemsField
              value={freeItems}
              onChange={setFreeItems}
              products={productOptions}
              error={errors.freeItems}
            />
          ) : null}
        </TabsContent>

        <TabsContent
          value="presentation"
          className="space-y-5 pt-5 data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:slide-in-from-right-2"
        >
          <Field label="Nombre" htmlFor="coupon-name" error={errors.name} required>
            <Input
              id="coupon-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Promo de verano"
              className="text-lg md:text-lg"
              aria-invalid={!!errors.name}
            />
          </Field>

          <Field
            label="Descripción"
            htmlFor="coupon-description"
            error={errors.description}
            hint="Lo que ve quien recibe el cupón."
          >
            <Textarea
              id="coupon-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="10% en toda la tienda hasta fin de mes"
              className="text-base md:text-base"
              aria-invalid={!!errors.description}
            />
          </Field>

          <Field label="Imagen" error={errors.imageUrl} hint="Opcional. Se sube a Blossom.">
            {/* The very same uploader the catalog uses: drag and drop, progress
                bar, signed BUD-11 auth and per-server fallback included. */}
            <ProductImageUpload
              value={image}
              onChange={setImage}
              onBusyChange={setUploading}
              title="Imagen del cupón"
              alt="Vista previa del cupón"
            />
          </Field>
        </TabsContent>

        <TabsContent
          value="limits"
          className="space-y-5 pt-5 data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:slide-in-from-right-2"
        >
          <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="coupon-limit-uses" className="text-base font-semibold">
                Limitar cuántos emitís
              </Label>
              <Switch
                id="coupon-limit-uses"
                checked={limitUses}
                onCheckedChange={setLimitUses}
              />
            </div>
            {limitUses ? (
              <Field label="Máximo de emisiones" htmlFor="coupon-max-uses" error={errors.maxUses}>
                <Input
                  id="coupon-max-uses"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="numeric max-w-40 text-lg md:text-lg"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  aria-invalid={!!errors.maxUses}
                />
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sin límite: podés emitir este cupón todas las veces que quieras.
              </p>
            )}
          </div>

          <Field
            label="Vence"
            htmlFor="coupon-expires"
            error={errors.expiresAt}
            hint="Opcional. Vale hasta el final de ese día."
          >
            <Input
              id="coupon-expires"
              type="date"
              className="numeric max-w-52 text-base md:text-base"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              aria-invalid={!!errors.expiresAt}
            />
          </Field>

          <PreviewCard
            name={name}
            description={description}
            imageUrl={image?.url ?? null}
            summary={summary}
          />
        </TabsContent>
      </Tabs>

      {serverError ? (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          {serverError}
        </p>
      ) : null}

      {/* Sticky so the way forward is always in reach, however tall the step. */}
      <div className="sticky bottom-0 -mx-4 mt-6 flex items-center justify-between gap-3 border-t border-border bg-popover px-4 pt-4 pb-1">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={index === 0 ? onCancel : () => setStep(STEPS[index - 1]!.id)}
          disabled={saving}
        >
          {index === 0 ? (
            "Cancelar"
          ) : (
            <>
              <ArrowLeft aria-hidden />
              Atrás
            </>
          )}
        </Button>

        {isLast ? (
          <Button type="submit" size="lg" disabled={saving || uploading}>
            {saving ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Guardando…
              </>
            ) : (
              <>
                <Check aria-hidden />
                {existing ? "Guardar cambios" : "Crear cupón"}
              </>
            )}
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            onClick={() => setStep(STEPS[index + 1]!.id)}
          >
            Siguiente
            <ArrowRight aria-hidden />
          </Button>
        )}
      </div>
    </form>
  )
}

function StepNumber({
  index,
  current,
  done,
  error,
}: {
  index: number
  current: boolean
  done: boolean
  error: boolean
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors",
        error
          ? "bg-danger text-background"
          : done
            ? "bg-success text-background"
            : current
              ? "bg-primary text-primary-foreground"
              : "bg-surface-3 text-muted-foreground"
      )}
    >
      {done ? <Check className="size-3.5" /> : index + 1}
    </span>
  )
}

function TypeCard({
  value,
  label,
  example,
  icon: Icon,
  selected,
  onSelect,
}: {
  value: CouponType
  label: string
  example: string
  icon: typeof BadgePercent
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected
          ? "border-primary bg-primary/10 shadow-sm"
          : "border-border-strong hover:border-foreground/40 hover:bg-surface-2"
      )}
      data-type={value}
    >
      <Icon
        className={cn("size-5", selected ? "text-primary" : "text-muted-foreground")}
        aria-hidden
      />
      <span className="text-base leading-tight font-semibold">{label}</span>
      <span className="text-xs leading-tight text-muted-foreground">{example}</span>
    </button>
  )
}

/** What the customer ends up holding. Worth showing before they hold it. */
function PreviewCard({
  name,
  description,
  imageUrl,
  summary,
}: {
  name: string
  description: string
  imageUrl: string | null
  summary: string | null
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-muted-foreground">Así se va a ver</p>
      <div className="flex items-center gap-4 rounded-2xl border border-primary/40 bg-surface-2 p-4">
        <div className="size-16 shrink-0 overflow-hidden rounded-xl bg-surface-3">
          {imageUrl ? (
            // Arbitrary Blossom hosts cannot go through next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center">
              <TicketPercent className="size-6 text-muted-foreground" aria-hidden />
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-lg font-bold">{name || "Sin nombre"}</p>
          <p className="text-base text-primary">{summary ?? "Completá el descuento"}</p>
          {description ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ProductSelect({
  value,
  onChange,
  options,
  placeholder,
  anyLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { d: string; title: string }[]
  placeholder: string
  /** When set, adds an explicit "applies to everything" choice. */
  anyLabel?: string
}) {
  const ANY = "__any__"
  return (
    <Select
      value={value || (anyLabel ? ANY : undefined)}
      onValueChange={(v) => onChange(v === ANY ? "" : v)}
    >
      <SelectTrigger className="h-12 w-full text-base">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {anyLabel ? <SelectItem value={ANY}>{anyLabel}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.d} value={o.d}>
            {o.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
      <Label htmlFor={htmlFor} className="text-base">
        {label}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * "Qué se lleva gratis" — products and how many of each.
 *
 * The picker chooses, and the rows below carry the quantities, so the same
 * searchable control the other types use does the searching here too. It is
 * asked NOT to render its own chips: a chip and a quantity row for the same
 * product would be the same product twice.
 *
 * Empty is an error rather than a default. Everywhere else in this form an
 * empty picker means "toda la compra"; here that would read as "the catalog,
 * free", which is not something a merchant means by accident.
 */
function FreeItemsField({
  value,
  onChange,
  products,
  error,
}: {
  value: FreeUnits[]
  onChange: (next: FreeUnits[]) => void
  products: { d: string; title: string }[]
  error?: string
}) {
  const titleOf = (d: string) =>
    products.find((p) => p.d === d)?.title ?? "Producto borrado"

  /** The picker speaks in `d`s; quantities of the ones already chosen survive. */
  const setSelection = (ds: string[]) =>
    onChange(ds.map((d) => value.find((i) => i.d === d) ?? { d, qty: 1 }))

  const setQty = (d: string, qty: number) =>
    onChange(
      value.map((i) =>
        i.d === d ? { ...i, qty: Math.min(Math.max(1, qty), MAX_FREE_QTY) } : i
      )
    )

  return (
    <Field
      label="Qué se lleva gratis"
      error={error}
      required
      hint="Se canjea por estos productos. No hace falta comprar nada más."
    >
      <div className="space-y-3">
        <ProductScopePicker
          value={value.map((i) => i.d)}
          onChange={setSelection}
          products={products}
          allLabel="Elegí los productos"
          emptyMeansAll={false}
          showSelected={false}
        />

        {value.length > 0 ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {value.map((item) => (
              <li key={item.d} className="flex items-center gap-3 p-2 pl-4">
                <span className="min-w-0 flex-1 truncate text-base">
                  {titleOf(item.d)}
                </span>

                <div className="flex items-center gap-1 rounded-full bg-surface-2 p-1">
                  <button
                    type="button"
                    onClick={() => setQty(item.d, item.qty - 1)}
                    disabled={item.qty <= 1}
                    aria-label={`Menos ${titleOf(item.d)}`}
                    className="grid size-8 place-items-center rounded-full text-muted-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Minus className="size-4" aria-hidden />
                  </button>
                  <span className="numeric min-w-6 text-center text-base font-semibold">
                    {item.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQty(item.d, item.qty + 1)}
                    disabled={item.qty >= MAX_FREE_QTY}
                    aria-label={`Más ${titleOf(item.d)}`}
                    className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => onChange(value.filter((i) => i.d !== item.d))}
                  aria-label={`Quitar ${titleOf(item.d)}`}
                  className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  )
}

/**
 * "Aplica a" — the same control for every discount that accepts a scope.
 *
 * Labelled as a question about reach rather than "Productos", because the
 * answer "todos" is a real answer and a field called "Productos" reads like
 * something you must fill in.
 */
function ScopeField({
  value,
  onChange,
  products,
  error,
  hint,
}: {
  value: string[]
  onChange: (next: string[]) => void
  products: { d: string; title: string }[]
  error?: string
  hint?: string
}) {
  return (
    <Field
      label="Aplica a"
      error={error}
      hint={hint ?? "Sin productos elegidos, el descuento vale para toda la compra."}
    >
      <ProductScopePicker value={value} onChange={onChange} products={products} />
    </Field>
  )
}
