import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { TickerChip, TickerChipButton } from "@/components/ui/ticker-chip"
import { CurrencyPreview, SegmentedPreview } from "./client-bits"

export const metadata = { title: "Design system" }

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "danger",
  "link",
] as const
const BUTTON_SIZES = ["lg", "default", "sm", "xs"] as const

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4 border-t border-border pt-8">
      <div className="space-y-1">
        <h2 className="text-h2">{title}</h2>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

export default function DesignPage() {
  // Never ship this route.
  if (process.env.NODE_ENV === "production") notFound()

  return (
    <main
      id="main"
      className="mx-auto w-full max-w-app space-y-10 px-4 py-10 md:px-8"
    >
      <header className="relative space-y-3 overflow-hidden rounded-2xl border border-border p-8">
        <div
          aria-hidden
          className="grid-flat pointer-events-none absolute inset-0 -z-10"
        />
        <h1 className="text-display">Merchant Manager</h1>
        <p className="max-w-prose text-muted-foreground">
          Sistema de diseño · La Crypta. Revisar a 360 / 768 / 1440, con axe y
          con &ldquo;Reduce motion&rdquo; activado.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <TickerChip>
            U$D <b className="font-semibold text-primary">64.114,28</b>
            <span aria-hidden className="text-border-strong">
              #
            </span>
            <b className="font-semibold text-primary">959.567</b>
          </TickerChip>
          <TickerChipButton tone="success" aria-label="Relays: 6 de 6 conectados">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            6/6
          </TickerChipButton>
          <TickerChipButton tone="warning" aria-label="Relays: 4 de 6 conectados">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            4/6
          </TickerChipButton>
          <TickerChipButton tone="danger" aria-label="Sin relays conectados">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            0/6
          </TickerChipButton>
        </div>
      </header>

      <Section
        title="Tipografía"
        note="line-height igual al font-size, tracking negativo — regla de lacrypta.ar."
      >
        <div className="space-y-4">
          <p className="text-hero">Hero 128</p>
          <p className="text-display">Display</p>
          <p className="text-h1">Encabezado 1</p>
          <p className="text-h2">Encabezado 2</p>
          <p className="text-h3">Encabezado 3</p>
          <p className="text-base">
            Cuerpo — ¿cuánto sale? Añadí una descripción. «Fernet con Coca»
          </p>
          <p className="text-sm text-muted-foreground">
            Muted 14px — 7,85:1 sobre el fondo.
          </p>
          <p className="numeric text-price text-primary">$ 7.300</p>
          <p className="numeric text-price-lg text-primary">2.780 sat</p>
        </div>
      </Section>

      <Section
        title="Botones"
        note="Pill h-12 px-8 · el foco cae FUERA del botón lima (offset 2px)."
      >
        <div className="space-y-4">
          {BUTTON_SIZES.map((size) => (
            <div key={size} className="flex flex-wrap items-center gap-3">
              <code className="w-16 shrink-0 text-xs text-muted-foreground">
                {size}
              </code>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size}>
                  {variant}
                </Button>
              ))}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <code className="w-16 shrink-0 text-xs text-muted-foreground">
              estado
            </code>
            <Button disabled>disabled</Button>
            <Button variant="outline" disabled>
              disabled
            </Button>
            <Button size="icon" aria-label="Icono">
              ✎
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Icono chico">
              ✕
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Badges" note="El texto es la señal; el color refuerza.">
        <div className="flex flex-wrap gap-2">
          {(
            [
              "default",
              "secondary",
              "destructive",
              "outline",
            ] as const
          ).map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
          <Badge className="border-success/30 bg-success-bg text-success">
            Publicado
          </Badge>
          <Badge className="border-warning/30 bg-warning-bg text-warning">
            Pendiente
          </Badge>
          <Badge className="border-danger/30 bg-danger-bg text-danger">
            Agotado
          </Badge>
          <Badge className="border-ars/30 bg-ars/10 text-ars">ARS</Badge>
          <Badge className="border-usd/30 bg-usd/10 text-usd">USD</Badge>
          <Badge className="border-sat/30 bg-sat/10 text-sat">SAT</Badge>
        </div>
      </Section>

      <Section
        title="Controles"
        note="Bordes con --border-strong (3,30:1). --border (1,31:1) es decorativo."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="d-1">Título</Label>
            <Input id="d-1" placeholder="Fernet con Coca" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="d-2">Inválido</Label>
            <Input id="d-2" aria-invalid defaultValue="—" />
            <p role="alert" className="text-sm text-danger">
              El precio debe ser mayor a 0
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="d-3">Deshabilitado</Label>
            <Input id="d-3" disabled placeholder="No editable" />
          </div>
          <div className="flex items-center gap-6 pt-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch /> Stock ilimitado
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox /> Activo
            </label>
          </div>
        </div>
      </Section>

      <Section title="Segmented control + moneda">
        <SegmentedPreview />
        <CurrencyPreview />
      </Section>

      <Section title="Cards y skeletons">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Fernet con Coca</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">Vaso de 500ml</p>
              <p className="numeric text-price text-primary">$ 7.300</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 pt-6">
              <Skeleton className="aspect-square w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/3" />
            </CardContent>
          </Card>
          <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed border-border-strong p-6 text-center">
            <p className="font-semibold">Todavía no tenés productos</p>
            <p className="text-sm text-muted-foreground">
              Creá el primero y publicalo en tu catálogo.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Superficies"
        note="surface-1 → surface-4 es la escala de elevación; no hay sombras."
      >
        {/* Class names are written out in full: Tailwind scans source text,
            so a constructed `bg-${s}` would never be emitted. */}
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["surface-1", "bg-surface-1"],
              ["surface-2", "bg-surface-2"],
              ["surface-3", "bg-surface-3"],
              ["surface-4", "bg-surface-4"],
            ] as const
          ).map(([name, cls]) => (
            <div
              key={name}
              className={`flex size-28 items-center justify-center rounded-xl border border-border text-xs text-muted-foreground ${cls}`}
            >
              {name}
            </div>
          ))}
          <div className="flex size-28 items-center justify-center rounded-xl border-2 border-border-strong text-xs text-muted-foreground">
            border-strong
          </div>
        </div>
      </Section>
    </main>
  )
}
