"use client"

import { useQuery } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  Ticket,
} from "lucide-react"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { EmptyState } from "@/components/feedback/empty-state"
import { PageHeader } from "@/components/shell/page-header"
import { useRedemptions } from "@/components/coupons/use-coupons"
import {
  MetricCard,
  OrderDetailDialog,
  OriginalTotals,
  allocationLabel,
  buildOrderView,
  formatSats,
  numberFormatter,
  shortId,
  type OrderView,
} from "@/components/orders/order-detail-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FilterSelect } from "@/components/ui/filter-select"
import { Input } from "@/components/ui/input"
import { Pager } from "@/components/ui/pager"
import { Skeleton } from "@/components/ui/skeleton"
import { useRates } from "@/hooks/use-rates"
import { KINDS } from "@/lib/domain/kinds"
import type { Benefit } from "@/lib/domain/coupon"
import {
  parseZapReceiptOrder,
  parseZapRequestOrder,
  type AllocatedZapOrderLine,
  type ZapOrderTotal,
  type ZapReceiptOrder,
} from "@/lib/domain/zap-order"
import { queryEvents } from "@/lib/nostr/backend"
import { verifySignedEventCached } from "@/lib/nostr/verify"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { CACHE, qk } from "@/lib/query/keys"
import { serializeCsv } from "@/lib/csv"
import { fold } from "@/lib/domain/slug"

const orderDateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
})
const orderTimeFormatter = new Intl.DateTimeFormat("es-AR", {
  timeStyle: "short",
})
/** Rows per page. Enough that scrolling is the norm and paging the exception. */
const PAGE_SIZE = 25

type SortKey = "date" | "order" | "sats"
type SortDirection = "asc" | "desc"
type PeriodFilter = "all" | "7" | "30" | "90"

interface ItemReportRow {
  d: string
  title: string
  qty: number
  sats: number
  allocatedLines: number
  estimatedLines: number
  unallocatedLines: number
  totals: ZapOrderTotal[]
}

/**
 * Native date inputs use the merchant's local calendar day. Convert that
 * complete day to an epoch range, rather than parsing YYYY-MM-DD as UTC and
 * accidentally moving orders near midnight into an adjacent day.
 */
function localDateBoundary(value: string, edge: "start" | "end"): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const start = new Date(year, month - 1, day)
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  ) {
    return null
  }
  return edge === "start"
    ? start.getTime()
    : new Date(year, month, day).getTime() - 1
}

function mergeTotals(target: Map<string, number>, totals: readonly ZapOrderTotal[]) {
  for (const total of totals) {
    target.set(total.currency, (target.get(total.currency) ?? 0) + total.amount)
  }
}

function exportTotals(totals: readonly ZapOrderTotal[]) {
  return totals
    .map((total) => `${total.amount} ${total.currency}`)
    .join(" | ")
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function localFileDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align = "left",
}: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  direction: SortDirection
  onSort: (key: SortKey) => void
  align?: "left" | "right"
}) {
  const active = sortKey === activeKey
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
          align === "right" ? "ml-auto" : ""
        }`}
      >
        {label}
        <Icon className="size-3.5" aria-hidden />
      </button>
    </th>
  )
}

/**
 * A date filter that matches the selects beside it.
 *
 * The native input used to sit under its own caption, which made those two
 * controls a head taller than every pill next to them — the row aligned at the
 * bottom and looked ragged at the top. Same shell as FilterSelect instead:
 * label inside, one height, one shape.
 *
 * A bare `input` rather than our `Input`, because that component brings its own
 * border, height and padding, and undoing all three is more markup than the
 * element it wraps.
 */
function DateFilter({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: string
  min?: string
  max?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex h-11 min-w-[10.5rem] flex-1 items-center gap-1.5 rounded-full border border-border-strong bg-background px-3.5 shadow-sm transition-[border-color,background-color,box-shadow] hover:bg-muted/55 focus-within:border-primary/60">
      <span className="shrink-0 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </span>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="numeric min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none [color-scheme:dark]"
      />
    </label>
  )
}

function ItemNames({
  lines,
  productTitles,
}: {
  lines: readonly AllocatedZapOrderLine[]
  productTitles: ReadonlyMap<string, string>
}) {
  if (lines.length === 0) {
    return <span className="text-sm text-muted-foreground">Sin detalle</span>
  }

  return (
    <ul className="min-w-64 space-y-1.5">
      {lines.map((line, index) => (
        <li key={`${line.d}-${index}`} className="min-w-0 truncate text-sm font-medium">
          {productTitles.get(line.d) ?? `Producto ${shortId(line.d)}`}
        </li>
      ))}
    </ul>
  )
}

export function OrdersScreen() {
  const { state } = useAuth()
  const { products, relayEntries } = useCatalog()
  const { rates } = useRates()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const [query, setQuery] = React.useState("")
  const [currency, setCurrency] = React.useState("all")
  const [period, setPeriod] = React.useState<PeriodFilter>("all")
  const [fromDate, setFromDate] = React.useState("")
  const [untilDate, setUntilDate] = React.useState("")
  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(
    null
  )
  const [page, setPage] = React.useState(1)
  const [sortKey, setSortKey] = React.useState<SortKey>("date")
  const [sortDirection, setSortDirection] =
    React.useState<SortDirection>("desc")
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const relays = React.useMemo(
    () =>
      dedupeRelays([
        ...relayEntries.filter((entry) => entry.read).map((entry) => entry.url),
        ...DEFAULT_RELAYS,
      ]),
    [relayEntries]
  )
  const relaysKey = relays.join(",")

  const receiptsQuery = useQuery({
    queryKey: [...qk.orders(pubkey ?? ""), relaysKey],
    queryFn: async () => {
      const events = await queryEvents(
        [{ kinds: [KINDS.ZAP_RECEIPT], "#p": [pubkey!] }],
        relays,
        { label: "Órdenes cobradas" }
      )
      // Warm the verify memo here, inside the await that already shows a
      // skeleton. Left to the parse below it would run two secp256k1 checks per
      // order during a commit — seconds of frozen tab for a busy merchant.
      for (const e of events) verifySignedEventCached(e)
      return events
    },
    enabled: !!pubkey,
    ...CACHE.orders,
  })

  // Reclaimed orders never reach a relay; they come from our own database.
  const { redemptions } = useRedemptions()

  const productTitles = React.useMemo(
    () => new Map(products.map((product) => [product.d, product.title])),
    [products]
  )

  /**
   * What a discounted order's coupon actually promised.
   *
   * The zap request only names the coupon (id, type, name) — enough to say
   * "hubo un cupón", not enough to say which beer was free. The redemption row
   * carries the terms frozen at mint time, which is what puts the discount on
   * the right line. Matched by order first; failing that, by coupon, because a
   * coupon redeemed before this app started filing orders still has its terms.
   */
  const benefitFor = React.useCallback(
    (order: ZapReceiptOrder): Benefit | null => {
      const couponId = order.coupon?.id
      if (!couponId) return null
      const requestId = order.zapRequest?.id
      const exact = requestId
        ? redemptions.find((r) => r.orderId === requestId)
        : undefined
      return (exact ?? redemptions.find((r) => r.couponId === couponId))?.benefit ?? null
    },
    [redemptions]
  )

  const orderViews = React.useMemo<OrderView[]>(() => {
    const paid = (receiptsQuery.data ?? [])
      .map((receipt) => parseZapReceiptOrder(receipt, pubkey ?? ""))
      .map((order) =>
        order ? buildOrderView(order, rates?.satPrice ?? null, benefitFor(order)) : null
      )
      .filter((view): view is OrderView => view !== null)

    /**
     * Orders a coupon took to zero. They were never invoiced, so no zap receipt
     * exists and relays have nothing to show — the row written when the coupon
     * was claimed is the only record there is.
     *
     * Only `amountMsat === 0` qualifies. A redemption with something left to pay
     * belongs to the receipt that will arrive for it; listing it here would post
     * an order the merchant has not been paid for, and then post it twice.
     */
    const receipted = new Set(paid.map((view) => view.order.zapRequest?.id).filter(Boolean))
    const reclaimed = redemptions
      .filter((r) => r.amountMsat === 0 && r.order && !receipted.has(r.order.id))
      .map((r) =>
        buildOrderView(parseZapRequestOrder(r.order, 0), rates?.satPrice ?? null, r.benefit)
      )
      .filter((view): view is OrderView => view !== null)

    return [...paid, ...reclaimed]
  }, [receiptsQuery.data, redemptions, pubkey, rates?.satPrice, benefitFor])

  const currencies = React.useMemo(
    () =>
      [...new Set(orderViews.flatMap((view) => view.currencies))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [orderViews]
  )

  const selectedOrder = React.useMemo(
    () =>
      orderViews.find((view) => view.id === selectedOrderId) ??
      null,
    [orderViews, selectedOrderId]
  )

  const filteredOrders = React.useMemo(() => {
    const normalizedQuery = fold(query)
    const cutoff =
      period === "all"
        ? 0
        : now - Number(period) * 24 * 60 * 60 * 1000
    const from = localDateBoundary(fromDate, "start")
    const until = localDateBoundary(untilDate, "end")

    const filtered = orderViews.filter((view) => {
      const receivedAt = view.receivedAt
      if (receivedAt < cutoff) return false
      if (from !== null && receivedAt < from) return false
      if (until !== null && receivedAt > until) return false
      if (currency !== "all" && !view.currencies.includes(currency)) return false
      if (!normalizedQuery) return true
      const haystack = [
        view.id,
        view.order.zapRequest?.id ?? "",
        view.order.coupon?.name ?? "",
        view.order.coupon?.id ?? "",
        ...view.lines.flatMap((line) => [
          line.d,
          productTitles.get(line.d) ?? "",
        ]),
      ]
        .map(fold)
        .join(" ")
      return haystack.includes(normalizedQuery)
    })

    const direction = sortDirection === "asc" ? 1 : -1
    return filtered.sort((a, b) => {
      let comparison = 0
      switch (sortKey) {
        case "order":
          comparison = a.id.localeCompare(b.id)
          break
        case "sats":
          comparison =
            (a.order.receiptSats ?? Number.NEGATIVE_INFINITY) -
            (b.order.receiptSats ?? Number.NEGATIVE_INFINITY)
          break
        case "date":
          comparison =
            a.receivedAt - b.receivedAt
          break
      }
      return (
        comparison * direction ||
        b.receivedAt - a.receivedAt ||
        a.id.localeCompare(b.id)
      )
    })
  }, [
    orderViews,
    query,
    currency,
    period,
    fromDate,
    untilDate,
    sortKey,
    sortDirection,
    productTitles,
    now,
  ])

  /**
   * The rows actually on screen.
   *
   * Only the TABLE is paginated. The metrics, the per-product report and the
   * CSV all keep working over the whole filtered set — a merchant asking "how
   * much did I take this month" wants the month, not whichever 25 orders the
   * pager happens to be showing.
   *
   * The page is clamped rather than reset by an effect: filtering down to
   * fewer pages while sitting on page 6 should show the last page, not an
   * empty table, and doing it here means no render ever sees the stale number.
   */
  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageOrders = filteredOrders.slice(pageStart, pageStart + PAGE_SIZE)

  const reportRows = React.useMemo<ItemReportRow[]>(() => {
    const rows = new Map<
      string,
      Omit<ItemReportRow, "totals"> & { totalsMap: Map<string, number> }
    >()
    for (const view of filteredOrders) {
      for (const line of view.lines) {
        const row = rows.get(line.d) ?? {
          d: line.d,
          title: productTitles.get(line.d) ?? `Producto ${shortId(line.d)}`,
          qty: 0,
          sats: 0,
          allocatedLines: 0,
          estimatedLines: 0,
          unallocatedLines: 0,
          totalsMap: new Map<string, number>(),
        }
        row.qty += line.qty
        if (line.sats === null) row.unallocatedLines += 1
        else {
          row.sats += line.sats
          row.allocatedLines += 1
          if (view.quality === "estimated") row.estimatedLines += 1
        }
        if (line.unitAmount !== undefined && line.currency) {
          mergeTotals(row.totalsMap, [
            {
              currency: line.currency,
              amount: line.unitAmount * line.qty,
            },
          ])
        }
        rows.set(line.d, row)
      }
    }
    return [...rows.values()]
      .map(({ totalsMap, ...row }) => ({
        ...row,
        totals: [...totalsMap].map(([currencyCode, amount]) => ({
          currency: currencyCode,
          amount,
        })),
      }))
      .sort((a, b) => b.qty - a.qty || b.sats - a.sats || a.title.localeCompare(b.title))
  }, [filteredOrders, productTitles])

  const metrics = React.useMemo(() => {
    const satsOrders = filteredOrders.filter(
      (view) => view.order.receiptSats !== null
    )
    const sats = satsOrders.reduce(
      (sum, view) => sum + (view.order.receiptSats ?? 0),
      0
    )
    const items = filteredOrders.reduce((sum, view) => sum + view.itemCount, 0)
    return {
      sats,
      items,
      average: satsOrders.length > 0 ? sats / satsOrders.length : null,
      exact: filteredOrders.filter((view) => view.quality === "exact").length,
      estimated: filteredOrders.filter((view) => view.quality === "estimated")
        .length,
      unavailable: filteredOrders.filter(
        (view) => view.quality === "unavailable"
      ).length,
      currencies: new Set(
        filteredOrders.flatMap((view) => view.currencies)
      ).size,
    }
  }, [filteredOrders])

  const visibleOriginalTotals = React.useMemo(() => {
    const totals = new Map<string, number>()
    for (const view of filteredOrders) mergeTotals(totals, view.totals)
    return [...totals].map(([currencyCode, amount]) => ({
      currency: currencyCode,
      amount,
    }))
  }, [filteredOrders])

  const maxReportQty = reportRows[0]?.qty ?? 0

  /**
   * Anything that changes WHICH orders are listed sends the reader back to page
   * one. Filtering while parked on page 4 and landing on a page that no longer
   * holds what you were looking at is the classic pagination bug; the clamp
   * above only saves you from an empty table, not from a confusing one.
   */
  const handleSort = React.useCallback(
    (nextKey: SortKey) => {
      setPage(1)
      if (nextKey === sortKey) {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
      } else {
        setSortKey(nextKey)
        setSortDirection(nextKey === "date" || nextKey === "sats" ? "desc" : "asc")
      }
    },
    [sortKey]
  )

  const resetFilters = () => {
    setPage(1)
    setQuery("")
    setCurrency("all")
    setPeriod("all")
    setFromDate("")
    setUntilDate("")
  }

  const updateQuery = (value: string) => {
    setPage(1)
    setQuery(value)
  }

  const updateCurrency = (value: string) => {
    setPage(1)
    setCurrency(value)
  }

  const updatePeriod = (value: PeriodFilter) => {
    setPage(1)
    setPeriod(value)
    setFromDate("")
    setUntilDate("")
  }

  const updateFromDate = (value: string) => {
    setPage(1)
    setFromDate(value)
    if (value) setPeriod("all")
    if (value && untilDate && value > untilDate) setUntilDate(value)
  }

  const updateUntilDate = (value: string) => {
    setPage(1)
    setUntilDate(value)
    if (value) setPeriod("all")
    if (value && fromDate && value < fromDate) setFromDate(value)
  }

  const exportOrdersCsv = () => {
    const csv = serializeCsv(
      [
        "Fecha y hora (ISO)",
        "Orden ID",
        "Zap request ID",
        "Ítems",
        "Unidades",
        "Total (sats)",
        "Monedas originales",
        "Cupón",
        "Descuento",
        "Calidad de asignación",
      ],
      filteredOrders.map((view) => [
        new Date(view.receivedAt).toISOString(),
        view.id,
        view.order.zapRequest?.id,
        view.lines.length > 0
          ? view.lines
              .map(
                (line) =>
                  `${productTitles.get(line.d) ?? `Producto ${shortId(line.d)}`} ×${line.qty}`
              )
              .join(" | ")
          : "Sin detalle",
        view.itemCount,
        view.source === "claim" ? 0 : view.order.receiptSats,
        exportTotals(view.totals),
        view.order.coupon ? view.order.coupon.name || view.order.coupon.type : "",
        exportTotals(view.order.discounts),
        allocationLabel(view.quality),
      ])
    )
    downloadCsv(`ordenes-${localFileDate()}.csv`, csv)
  }

  const exportItemsCsv = () => {
    const csv = serializeCsv(
      [
        "Producto ID",
        "Producto",
        "Cantidad",
        "Sats atribuidos",
        "Sats por unidad",
        "Moneda original",
        "Líneas exactas",
        "Líneas estimadas",
        "Líneas sin asignar",
      ],
      reportRows.map((row) => [
        row.d,
        row.title,
        row.qty,
        row.allocatedLines > 0 ? row.sats : null,
        row.allocatedLines > 0 ? row.sats / row.qty : null,
        exportTotals(row.totals),
        row.allocatedLines - row.estimatedLines,
        row.estimatedLines,
        row.unallocatedLines,
      ])
    )
    downloadCsv(`reporte-productos-${localFileDate()}.csv`, csv)
  }

  const action = (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={filteredOrders.length === 0}
          >
            <Download aria-hidden />
            Exportar CSV
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 p-1.5">
          <DropdownMenuLabel className="px-2.5 py-2">
            Filtros activos
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={exportOrdersCsv}
            className="items-start px-2.5 py-2.5"
          >
            <span className="grid gap-0.5">
              <span className="font-semibold">Órdenes visibles</span>
              <span className="text-xs text-muted-foreground">
                Una fila por cobro · {filteredOrders.length} órdenes
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={exportItemsCsv}
            disabled={reportRows.length === 0}
            className="items-start px-2.5 py-2.5"
          >
            <span className="grid gap-0.5">
              <span className="font-semibold">Ítems totalizados</span>
              <span className="text-xs text-muted-foreground">
                Un renglón por producto · {reportRows.length} productos
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="sm"
        disabled={receiptsQuery.isFetching}
        onClick={() => void receiptsQuery.refetch()}
      >
        <RefreshCw
          className={
            receiptsQuery.isFetching ? "motion-safe:animate-spin" : undefined
          }
          aria-hidden
        />
        Actualizar
      </Button>
    </div>
  )

  if (receiptsQuery.isPending) {
    return (
      <>
        <PageHeader
          title="Órdenes"
          description="Pagos confirmados por zap receipt."
          action={action}
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="mt-6 h-96 w-full rounded-2xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Órdenes"
        count={orderViews.length}
        description="Libro completo de cobros, cantidades e importes por producto."
        action={action}
      />

      {receiptsQuery.isError ? (
        <p
          role="alert"
          className="mb-6 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          No pudimos actualizar las órdenes. Mostramos la última lectura
          disponible.
        </p>
      ) : null}

      {orderViews.length === 0 ? (
        <EmptyState
          title="Todavía no hay órdenes cobradas"
          description="Cuando el proveedor publique un zap receipt para tu comercio, el pedido va a aparecer acá con sus ítems y cantidades."
          action={
            <Button
              variant="outline"
              onClick={() => void receiptsQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              Buscar órdenes
            </Button>
          }
        />
      ) : (
        <>
          <section
            aria-label="Resumen de órdenes"
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          >
            <MetricCard
              label="Cobrado"
              value={formatSats(metrics.sats)}
              note={`${filteredOrders.length} órdenes visibles`}
              primary
            />
            <MetricCard
              label="Unidades"
              value={numberFormatter.format(metrics.items)}
              note={`${reportRows.length} productos distintos`}
            />
            <MetricCard
              label="Ticket promedio"
              value={formatSats(metrics.average)}
              note="Sobre receipts con BOLT-11 legible"
            />
            <MetricCard
              label="Cobertura por ítem"
              value={`${metrics.exact + metrics.estimated}/${filteredOrders.length}`}
              note={`${metrics.estimated} estimadas · ${metrics.unavailable} sin asignar`}
            />
          </section>

          <section aria-label="Filtros de órdenes" className="mt-6">
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 xl:flex-row xl:items-end">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => updateQuery(event.target.value)}
                  placeholder="Buscar orden o producto…"
                  aria-label="Buscar órdenes"
                  className="h-11 rounded-full pl-10"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label="Moneda"
                  value={currency}
                  onValueChange={updateCurrency}
                  options={[
                    { value: "all", label: "Todas las monedas" },
                    ...currencies.map((code) => ({ value: code, label: code })),
                  ]}
                />
                <FilterSelect
                  label="Período"
                  value={period}
                  onValueChange={(value) => updatePeriod(value as PeriodFilter)}
                  options={[
                    { value: "all", label: "Todo el historial" },
                    { value: "7", label: "Últimos 7 días" },
                    { value: "30", label: "Últimos 30 días" },
                    { value: "90", label: "Últimos 90 días" },
                  ]}
                />
                <fieldset
                  className="flex flex-wrap gap-2"
                  aria-label="Rango exacto de fechas"
                >
                  <DateFilter
                    label="Desde"
                    value={fromDate}
                    max={untilDate || undefined}
                    onChange={updateFromDate}
                  />
                  <DateFilter
                    label="Hasta"
                    value={untilDate}
                    min={fromDate || undefined}
                    onChange={updateUntilDate}
                  />
                </fieldset>
                {query ||
                currency !== "all" ||
                period !== "all" ||
                fromDate ||
                untilDate ? (
                  <Button
                    variant="ghost"
                    className="h-11 rounded-full"
                    onClick={resetFilters}
                  >
                    Limpiar
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
              {filteredOrders.length > 0
                ? `Mostrando ${pageStart + 1}–${pageStart + pageOrders.length} de ${filteredOrders.length} órdenes`
                : "Mostrando 0 órdenes"}
              {filteredOrders.length !== orderViews.length
                ? ` (${orderViews.length} en total)`
                : ""}
              . El rango de fechas incluye ambos días y también actualiza el
              reporte.
            </p>
          </section>

          {filteredOrders.length === 0 ? (
            <EmptyState
              className="mt-4"
              title="No hay órdenes con estos filtros"
              description="Probá otra búsqueda, moneda, período o fecha."
              action={
                <Button variant="ghost" onClick={resetFilters}>
                  Limpiar filtros
                </Button>
              }
            />
          ) : (
            <>
              <section className="mt-4" aria-labelledby="orders-table-title">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <div>
                    <h2 id="orders-table-title" className="text-h3">
                      Detalle de órdenes
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Hacé click en una orden para ver el detalle. Los
                      encabezados sirven para ordenar.
                    </p>
                  </div>
                </div>
                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] border-collapse">
                      <caption className="sr-only">
                        Órdenes cobradas con ítems, cantidades, moneda original
                        e importe en sats
                      </caption>
                      <thead className="border-b border-border bg-surface-2">
                        <tr>
                          <SortHeader
                            label="Fecha"
                            sortKey="date"
                            activeKey={sortKey}
                            direction={sortDirection}
                            onSort={handleSort}
                          />
                          <SortHeader
                            label="Orden"
                            sortKey="order"
                            activeKey={sortKey}
                            direction={sortDirection}
                            onSort={handleSort}
                          />
                          <th
                            scope="col"
                            className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                          >
                            Ítems
                          </th>
                          <SortHeader
                            label="Total"
                            sortKey="sats"
                            activeKey={sortKey}
                            direction={sortDirection}
                            onSort={handleSort}
                            align="right"
                          />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {pageOrders.map((view) => (
                          <tr
                            key={view.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Abrir orden ${shortId(view.id)}`}
                            onClick={() => setSelectedOrderId(view.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault()
                                setSelectedOrderId(view.id)
                              }
                            }}
                            className="group cursor-pointer align-top outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <td className="whitespace-nowrap px-4 py-4 text-sm">
                              <span className="flex items-start gap-2">
                                <time
                                  dateTime={new Date(
                                    view.receivedAt
                                  ).toISOString()}
                                  className="leading-tight"
                                >
                                  <span className="block">
                                    {orderDateFormatter.format(
                                      view.receivedAt
                                    )}
                                  </span>
                                  <span className="numeric mt-1 block text-xs text-muted-foreground">
                                    {orderTimeFormatter.format(
                                      view.receivedAt
                                    )}
                                  </span>
                                </time>
                                <ChevronRight
                                  className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                  aria-hidden
                                />
                              </span>
                            </td>
                            <td className="px-4 py-4">
                              <p
                                className="numeric text-sm font-semibold"
                                title={view.id}
                              >
                                {shortId(view.id)}
                              </p>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {view.source === "claim" ? (
                                  <Badge className="border-primary/30 bg-primary/10 text-primary">
                                    Reclamada
                                  </Badge>
                                ) : (
                                  <Badge className="border-success/30 bg-success-bg text-success">
                                    Cobrada
                                  </Badge>
                                )}
                                {/* The coupon on the row, not just inside the
                                    dialog: the merchant reconciling the day
                                    needs to see which sales were discounted
                                    without opening every one of them. */}
                                {view.order.coupon ? (
                                  <Badge
                                    variant="outline"
                                    className="max-w-40 truncate border-border-strong"
                                    title={view.order.coupon.id}
                                  >
                                    <Ticket className="size-3" aria-hidden />
                                    {view.order.coupon.name || view.order.coupon.type}
                                  </Badge>
                                ) : null}
                                {view.quality === "estimated" ? (
                                  <Badge
                                    variant="outline"
                                    className="border-warning/40 text-warning"
                                  >
                                    sats estimados
                                  </Badge>
                                ) : null}
                                {!view.order.zapRequest ? (
                                  <Badge
                                    variant="outline"
                                    className="border-warning/40 text-warning"
                                  >
                                    sin zap request
                                  </Badge>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-4 py-4">
                              <ItemNames
                                lines={view.lines}
                                productTitles={productTitles}
                              />
                            </td>
                            <td className="px-4 py-4 text-right">
                              <p className="numeric whitespace-nowrap text-sm font-bold">
                                {view.source === "claim"
                                  ? "Sin cargo"
                                  : formatSats(view.order.receiptSats)}
                              </p>
                              <div className="mt-1">
                                <OriginalTotals totals={view.totals} />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t border-border bg-surface-2 text-sm font-semibold">
                        <tr>
                          {/* The filtered set, not the page: the metrics above
                              and the report below count the same rows, and a
                              footer that changed with the pager would be the
                              only number on screen answering a question nobody
                              asked. */}
                          <td className="px-4 py-3" colSpan={3}>
                            Total filtrado
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="numeric whitespace-nowrap text-primary">
                              {formatSats(metrics.sats)}
                            </p>
                            <div className="mt-1">
                              <OriginalTotals totals={visibleOriginalTotals} />
                            </div>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  <Pager
                    page={currentPage}
                    pageCount={pageCount}
                    onPage={setPage}
                    label="Paginación de órdenes"
                  />
                </div>
              </section>

              <OrderDetailDialog
                view={selectedOrder}
                productTitles={productTitles}
                onOpenChange={(open) => {
                  if (!open) setSelectedOrderId(null)
                }}
              />

              <section
                className="mt-10 border-t border-border pt-8"
                aria-labelledby="items-report-title"
              >
                <div className="mb-5 flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <BarChart3 className="size-5" aria-hidden />
                  </span>
                  <div>
                    <h2 id="items-report-title" className="text-h2">
                      Reporte por producto
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Cantidad, moneda original y sats atribuidos dentro de los
                      filtros activos.
                    </p>
                  </div>
                </div>

                {reportRows.length > 0 ? (
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                    <figure className="rounded-2xl border border-border bg-card p-5">
                      <figcaption>
                        <h3 className="text-h3">Unidades por producto</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Top 6 · {filteredOrders.length} órdenes visibles
                        </p>
                      </figcaption>
                      <ol className="mt-5 space-y-4">
                        {reportRows.slice(0, 6).map((row) => (
                          <li
                            key={row.d}
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1"
                          >
                            <span className="truncate text-sm font-medium">
                              {row.title}
                            </span>
                            <span className="numeric text-sm font-bold">
                              {numberFormatter.format(row.qty)}
                            </span>
                            <span className="col-span-2 h-2 overflow-hidden rounded-full bg-surface-3">
                              <span
                                className="block h-full rounded-full bg-primary"
                                style={{
                                  width: `${maxReportQty > 0 ? (row.qty / maxReportQty) * 100 : 0}%`,
                                }}
                                aria-hidden
                              />
                            </span>
                          </li>
                        ))}
                      </ol>
                    </figure>

                    <div className="overflow-hidden rounded-2xl border border-border bg-card">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] border-collapse">
                          <caption className="sr-only">
                            Reporte agregado por producto
                          </caption>
                          <thead className="border-b border-border bg-surface-2">
                            <tr>
                              <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Producto
                              </th>
                              <th
                                scope="col"
                                className="px-4 py-3 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Cantidad
                              </th>
                              <th
                                scope="col"
                                className="px-4 py-3 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Moneda original
                              </th>
                              <th
                                scope="col"
                                className="px-4 py-3 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Sats
                              </th>
                              <th
                                scope="col"
                                className="px-4 py-3 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Sats/unidad
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {reportRows.map((row) => (
                              <tr key={row.d} className="align-top">
                                <td className="px-4 py-3">
                                  <p className="text-sm font-semibold">
                                    {row.title}
                                  </p>
                                  <p className="numeric mt-0.5 text-xs text-muted-foreground">
                                    {shortId(row.d)}
                                  </p>
                                </td>
                                <td className="numeric px-4 py-3 text-right text-sm font-bold">
                                  {numberFormatter.format(row.qty)}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <OriginalTotals totals={row.totals} />
                                </td>
                                <td className="numeric whitespace-nowrap px-4 py-3 text-right text-sm">
                                  {row.allocatedLines > 0
                                    ? `${row.estimatedLines > 0 ? "≈ " : ""}${formatSats(row.sats)}`
                                    : "—"}
                                  {row.unallocatedLines > 0 ? (
                                    <span
                                      className="ml-1 text-warning"
                                      title="Hay líneas sin importe asignable"
                                    >
                                      *
                                    </span>
                                  ) : null}
                                </td>
                                <td className="numeric whitespace-nowrap px-4 py-3 text-right text-sm">
                                  {row.allocatedLines > 0
                                    ? `${row.estimatedLines > 0 ? "≈ " : ""}${formatSats(row.sats / row.qty)}`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-2xl border border-dashed border-border-strong p-6 text-sm text-muted-foreground">
                    Los receipts visibles no incluyen líneas de producto
                    suficientes para armar el reporte.
                  </p>
                )}

                <div className="mt-4 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                  <p className="rounded-xl border border-border bg-card px-4 py-3">
                    <strong className="text-foreground">Fuente:</strong> el total
                    en sats se decodifica del BOLT-11 del zap receipt; productos,
                    cantidades y moneda original salen del zap request firmado.
                  </p>
                  <p className="rounded-xl border border-border bg-card px-4 py-3">
                    <strong className="text-foreground">Reparto:</strong>{" "}
                    {metrics.exact} exactos · {metrics.estimated} estimados por
                    mezcla de monedas · {metrics.unavailable} sin datos
                    suficientes.
                  </p>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </>
  )
}
