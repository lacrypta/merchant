"use client"

import { Download, Loader2 } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { TickerChip } from "@/components/ui/ticker-chip"
import { useWoo } from "@/components/woo/woo-provider"
import { formatPrice } from "@/lib/domain/price"
import {
  applyImport,
  planImport,
  type ImportCandidate,
} from "@/lib/domain/woo-product"
import { recordProductSync } from "@/lib/domain/woo-sync-state"
import { fetchAllProducts, setProductSku, WooApiError } from "@/lib/woo/client"
import { cn } from "@/lib/utils"

type Phase = "loading" | "review" | "applying" | "error"

export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { state: auth } = useAuth()
  const { products, categories, saveProducts } = useCatalog()
  const { connection, syncState, saveSyncState } = useWoo()
  const pubkey = auth.status === "ready" ? auth.pubkey : null

  const [phase, setPhase] = React.useState<Phase>("loading")
  const [plan, setPlan] = React.useState<ImportCandidate[]>([])
  const [chosen, setChosen] = React.useState<Set<number>>(new Set())
  const [loaded, setLoaded] = React.useState(0)
  const [problem, setProblem] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || !connection) return

    let cancelled = false
    const controller = new AbortController()

    // Deferred: setState directly in an effect body cascades a render.
    const timer = setTimeout(() => void run(), 0)

    async function run() {
      if (cancelled || !connection) return
      setPhase("loading")
      setLoaded(0)
      setProblem(null)

      try {
        const wooProducts = await fetchAllProducts(connection, {
          signal: controller.signal,
          onProgress: (n) => {
            if (!cancelled) setLoaded(n)
          },
        })
        if (cancelled) return

        const next = planImport(wooProducts, products)
        setPlan(next)
        // Everything importable is pre-selected: the merchant opened this to
        // import, not to tick 80 boxes.
        setChosen(
          new Set(next.flatMap((c, i) => (c.action === "skip" ? [] : [i])))
        )
        setPhase("review")
      } catch (e) {
        if (cancelled) return
        setProblem(
          e instanceof WooApiError
            ? e.message
            : "No pudimos leer los productos de la tienda."
        )
        setPhase("error")
      }
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
    // Re-planning on every catalog keystroke would fight the merchant's
    // selection; the plan is a snapshot taken when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection])

  const counts = React.useMemo(() => {
    let create = 0
    let update = 0
    let skip = 0
    for (const [i, c] of plan.entries()) {
      if (c.action === "skip") skip++
      else if (!chosen.has(i)) continue
      else if (c.action === "create") create++
      else update++
    }
    return { create, update, skip }
  }, [plan, chosen])

  async function apply() {
    if (!connection || !pubkey) return
    setPhase("applying")

    const selected = plan.filter((c, i) => c.action !== "skip" && chosen.has(i))

    const { products: imported, links, skuWriteFailures } = await applyImport(
      selected,
      {
        storeCurrency: connection.storeCurrency,
        pubkey,
        knownCategorySlugs: new Set(categories.map((c) => c.slug)),
        writeSku: (id, sku) => setProductSku(connection, id, sku),
      }
    )

    saveProducts(imported)

    let state = syncState
    for (const link of links) state = recordProductSync(state, link)
    try {
      await saveSyncState(state)
    } catch {
      // The link record is a cache — it can be rebuilt from SKUs. Losing it
      // must not lose the import.
    }

    onOpenChange(false)

    if (imported.length === 0) {
      toast.error("No se importó ningún producto.")
    } else {
      toast.success(
        `${imported.length} ${imported.length === 1 ? "producto" : "productos"} en el borrador. Revisá y guardá los cambios.`,
        {
          description:
            skuWriteFailures.length > 0
              ? `${skuWriteFailures.length} quedaron afuera: no pudimos escribirles el SKU en WooCommerce.`
              : undefined,
        }
      )
    }
  }

  function toggle(i: number) {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const selectable = plan.filter((c) => c.action !== "skip").length
  const allChosen = selectable > 0 && chosen.size === selectable

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Importar de WooCommerce</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {phase === "loading"
              ? `Leyendo la tienda… ${loaded} ${loaded === 1 ? "producto" : "productos"}`
              : phase === "error"
                ? "No pudimos leer la tienda."
                : `${counts.create} a crear · ${counts.update} a actualizar${
                    counts.skip > 0 ? ` · ${counts.skip} salteados` : ""
                  }`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {phase === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Buscando productos…
          </div>
        ) : phase === "error" ? (
          <p role="alert" className="py-6 text-sm text-danger">
            {problem}
          </p>
        ) : plan.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            La tienda no tiene productos publicados.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setChosen(
                    allChosen
                      ? new Set()
                      : new Set(
                          plan.flatMap((c, i) => (c.action === "skip" ? [] : [i]))
                        )
                  )
                }
              >
                {allChosen ? "No seleccionar ninguno" : "Seleccionar todos"}
              </Button>
              <span className="numeric text-xs text-muted-foreground">
                {chosen.size}/{selectable}
              </span>
            </div>

            <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
              {plan.map((c, i) => (
                <li
                  key={`${c.woo.id}-${i}`}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border border-border bg-card p-3",
                    c.action === "skip" && "opacity-50"
                  )}
                >
                  <Checkbox
                    checked={chosen.has(i)}
                    disabled={c.action === "skip"}
                    onCheckedChange={() => toggle(i)}
                    aria-label={`Importar ${c.woo.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.woo.name}</p>
                    <p className="numeric truncate text-xs text-muted-foreground">
                      {c.sku}
                      {c.writeSkuBack ? " · nuevo" : ""}
                      {c.reason ? ` · ${c.reason}` : ""}
                    </p>
                  </div>
                  <span className="numeric shrink-0 text-xs text-muted-foreground">
                    {c.woo.manage_stock
                      ? `${c.woo.stock_quantity ?? 0} u.`
                      : "sin stock"}
                  </span>
                  <span className="numeric shrink-0 text-sm">
                    {c.woo.regular_price || c.woo.price
                      ? formatPrice(
                          Number(c.woo.regular_price || c.woo.price),
                          connection?.storeCurrency ?? "ARS"
                        )
                      : "—"}
                  </span>
                  <TickerChip
                    tone={
                      c.action === "create"
                        ? "success"
                        : c.action === "update"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {c.action === "create"
                      ? "nuevo"
                      : c.action === "update"
                        ? "actualiza"
                        : "salteado"}
                  </TickerChip>
                </li>
              ))}
            </ul>
          </>
        )}

        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void apply()}
            disabled={phase !== "review" || chosen.size === 0}
          >
            {phase === "applying" ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Importando…
              </>
            ) : (
              <>
                <Download className="size-4" aria-hidden />
                Importar {chosen.size > 0 ? chosen.size : ""}
              </>
            )}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
