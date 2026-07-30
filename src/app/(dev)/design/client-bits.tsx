"use client"

import * as React from "react"

import { SegmentedControl } from "@/components/ui/segmented-control"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function SegmentedPreview() {
  const [status, setStatus] = React.useState<"todos" | "activos" | "ocultos">(
    "todos"
  )
  return (
    <div className="space-y-3">
      <SegmentedControl
        aria-label="Filtro de estado"
        value={status}
        onValueChange={setStatus}
        options={[
          { value: "todos", label: "Todos" },
          { value: "activos", label: "Activos" },
          { value: "ocultos", label: "Ocultos" },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        Seleccionado: <b className="text-foreground">{status}</b>
      </p>
    </div>
  )
}

const CURRENCIES = [
  { value: "ARS", label: "ARS", className: "data-[state=on]:bg-primary" },
  { value: "USD", label: "USD", className: "data-[state=on]:bg-primary" },
  { value: "SAT", label: "SAT", className: "data-[state=on]:bg-primary" },
] as const

type Currency = (typeof CURRENCIES)[number]["value"]

/** Mirrors src/lib/domain/price.ts — currency codes, never a bare `$`. */
function formatPrice(value: number, currency: Currency): string {
  const n = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(
    value
  )
  if (currency === "SAT") return `${n} sat`
  return `${currency} ${n}`
}

export function CurrencyPreview() {
  const [currency, setCurrency] = React.useState<Currency>("ARS")
  const [amount, setAmount] = React.useState("7300")
  const value = Number(amount.replace(/[^\d]/g, "")) || 0

  return (
    <div className="grid gap-4 pt-4 md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-2">
        <Label htmlFor="d-price">Precio</Label>
        <Input
          id="d-price"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <p className="numeric text-sm text-muted-foreground">
          {formatPrice(value, currency)}
          <span aria-hidden> · </span>
          <span>≈ {formatPrice(Math.round(value / 1.1), "USD")}</span>
        </p>
      </div>
      <SegmentedControl
        aria-label="Moneda"
        value={currency}
        onValueChange={setCurrency}
        options={CURRENCIES}
      />
    </div>
  )
}
