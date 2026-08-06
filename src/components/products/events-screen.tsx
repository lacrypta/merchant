"use client"

import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Copy, RefreshCw, Search } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { EmptyState } from "@/components/feedback/empty-state"
import { PageHeader } from "@/components/shell/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FilterSelect } from "@/components/ui/filter-select"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { KINDS } from "@/lib/domain/kinds"
import { fold } from "@/lib/domain/slug"
import { queryEvents } from "@/lib/nostr/backend"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"
import { tagValue, tagValues } from "@/lib/nostr/tags"
import type { SignedEvent } from "@/lib/nostr/types"
import { CACHE, qk } from "@/lib/query/keys"

const dateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
})
const eventDateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
})
const eventTimeFormatter = new Intl.DateTimeFormat("es-AR", {
  timeStyle: "short",
})

/**
 * The kinds this app writes to relays. 30403 stays listed even though the
 * draft feature was removed: it still holds deletion tombstones and any
 * pre-removal drafts pending the sweep. Deliberately absent: 9734 (zap
 * request, firmado con clave efímera y enviado al callback LNURL), 24242
 * (autorización Blossom, viaja como header HTTP), 9735 (zap receipt, lo firma
 * el proveedor Lightning) y 0 (esta app nunca publica perfiles).
 */
const PUBLISHED_KINDS = [
  KINDS.PRODUCT,
  KINDS.PRODUCT_DRAFT,
  KINDS.CATEGORY,
  KINDS.DELETION,
  KINDS.RELAY_LIST,
  KINDS.APP_DATA,
] as const

const KIND_META: Record<number, { label: string; badgeClass: string }> = {
  [KINDS.PRODUCT]: {
    label: "Producto",
    badgeClass: "border-success/30 bg-success-bg text-success",
  },
  [KINDS.PRODUCT_DRAFT]: {
    label: "Legado",
    badgeClass: "border-warning/40 bg-warning-bg text-warning",
  },
  [KINDS.CATEGORY]: {
    label: "Categoría",
    badgeClass: "border-info/30 bg-info-bg text-info",
  },
  [KINDS.DELETION]: {
    label: "Borrado",
    badgeClass: "border-danger/30 bg-danger-bg text-danger",
  },
  [KINDS.RELAY_LIST]: {
    label: "Relays",
    badgeClass: "border-border-strong bg-surface-3 text-foreground",
  },
  [KINDS.APP_DATA]: {
    label: "Config",
    badgeClass: "border-border-strong bg-surface-3 text-foreground",
  },
}

function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

function summarize(event: SignedEvent): string {
  switch (event.kind) {
    case KINDS.PRODUCT:
    case KINDS.PRODUCT_DRAFT: {
      const title = tagValue(event, "title") ?? "Producto sin título"
      const tombstone = event.tags.some((tag) => tag[0] === "deleted")
      return tombstone ? `${title} · tombstone` : title
    }
    case KINDS.CATEGORY:
      return tagValue(event, "title") ?? "Categoría sin título"
    case KINDS.DELETION: {
      const refs = tagValues(event, "e").length + tagValues(event, "a").length
      return refs === 1 ? "1 referencia borrada" : `${refs} referencias borradas`
    }
    case KINDS.RELAY_LIST: {
      const count = tagValues(event, "r").length
      return count === 1 ? "1 relay declarado" : `${count} relays declarados`
    }
    case KINDS.APP_DATA:
      return "Contenido cifrado (NIP-44)"
    default:
      return shortId(event.id)
  }
}

/** Secondary line under the summary: the `d` for addressable kinds, the id otherwise. */
function detailSubline(event: SignedEvent): string {
  const d = tagValue(event, "d")
  return d ? `d: ${d}` : shortId(event.id)
}

export function EventsScreen() {
  const { state } = useAuth()
  const pubkey = state.status === "ready" ? state.pubkey : null
  const { relayEntries } = useCatalog()

  const [query, setQuery] = React.useState("")
  const [kindFilter, setKindFilter] = React.useState("all")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const relays = React.useMemo(
    () =>
      dedupeRelays([
        ...relayEntries.filter((entry) => entry.read).map((entry) => entry.url),
        ...DEFAULT_RELAYS,
      ]),
    [relayEntries]
  )
  const relaysKey = relays.join(",")

  const eventsQuery = useQuery({
    queryKey: [...qk.events(pubkey ?? ""), relaysKey],
    queryFn: () =>
      queryEvents(
        [{ kinds: [...PUBLISHED_KINDS], authors: [pubkey!] }],
        relays,
        { label: "Eventos publicados" }
      ),
    enabled: !!pubkey,
    ...CACHE.events,
  })

  const events = React.useMemo(
    () =>
      [...(eventsQuery.data ?? [])].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
      ),
    [eventsQuery.data]
  )

  const filteredEvents = React.useMemo(() => {
    const normalizedQuery = fold(query)
    return events.filter((event) => {
      if (kindFilter !== "all" && String(event.kind) !== kindFilter) return false
      if (!normalizedQuery) return true
      const haystack = [
        event.id,
        tagValue(event, "d") ?? "",
        tagValue(event, "title") ?? "",
        event.content,
        KIND_META[event.kind]?.label ?? "",
      ]
        .map(fold)
        .join(" ")
      return haystack.includes(normalizedQuery)
    })
  }, [events, kindFilter, query])

  const selectedEvent = React.useMemo(
    () => events.find((event) => event.id === selectedId) ?? null,
    [events, selectedId]
  )

  const hasActiveFilters = query !== "" || kindFilter !== "all"

  const resetFilters = () => {
    setQuery("")
    setKindFilter("all")
  }

  const copyJson = async () => {
    if (!selectedEvent) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedEvent, null, 2))
      toast.success("JSON copiado")
    } catch {
      toast.error("No se pudo copiar el JSON")
    }
  }

  const action = (
    <Button
      variant="outline"
      size="sm"
      disabled={eventsQuery.isFetching}
      onClick={() => void eventsQuery.refetch()}
    >
      <RefreshCw
        className={
          eventsQuery.isFetching ? "motion-safe:animate-spin" : undefined
        }
        aria-hidden
      />
      Actualizar
    </Button>
  )

  const description =
    "Inspector de los eventos Nostr que esta app publicó con tu clave: productos, categorías, borrados, lista de relays y configuración cifrada."

  if (eventsQuery.isPending) {
    return (
      <>
        <PageHeader title="Eventos" description={description} action={action} />
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-96 w-full rounded-2xl" />
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Eventos"
        count={events.length}
        description={description}
        action={action}
      />

      {eventsQuery.isError ? (
        <p
          role="alert"
          className="mb-6 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          No pudimos actualizar los eventos. Mostramos la última lectura
          disponible.
        </p>
      ) : null}

      {events.length === 0 ? (
        <EmptyState
          title="Todavía no hay eventos publicados"
          description="Cuando publiques productos, categorías o configuración desde esta app, los eventos firmados van a aparecer acá."
          action={
            <Button
              variant="outline"
              onClick={() => void eventsQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              Buscar eventos
            </Button>
          }
        />
      ) : (
        <>
          <section aria-label="Filtros de eventos">
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 md:flex-row md:items-center">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Buscar por id, d, título o contenido…"
                  aria-label="Buscar eventos"
                  className="h-11 rounded-full pl-10"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label="Tipo"
                  value={kindFilter}
                  onValueChange={setKindFilter}
                  options={[
                    { value: "all", label: "Todos los tipos" },
                    ...PUBLISHED_KINDS.map((kind) => ({
                      value: String(kind),
                      label: `${KIND_META[kind].label} (${kind})`,
                    })),
                  ]}
                />
                {hasActiveFilters ? (
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
              Mostrando {filteredEvents.length} de {events.length} eventos.
            </p>
          </section>

          {filteredEvents.length === 0 ? (
            <EmptyState
              className="mt-4"
              title="No hay eventos con estos filtros"
              description="Probá otra búsqueda u otro tipo de evento."
              action={
                <Button variant="ghost" onClick={resetFilters}>
                  Limpiar filtros
                </Button>
              }
            />
          ) : (
            <section className="mt-4" aria-labelledby="events-table-title">
              <h2 id="events-table-title" className="sr-only">
                Eventos publicados
              </h2>
              <div className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse">
                    <caption className="sr-only">
                      Eventos Nostr publicados por esta app con tu clave, con
                      tipo, detalle y fecha
                    </caption>
                    <thead className="border-b border-border bg-surface-2">
                      <tr>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Fecha
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Tipo
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Detalle
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Client
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          ID
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredEvents.map((event) => {
                        const meta = KIND_META[event.kind]
                        const fromThisApp =
                          tagValue(event, "client") === "merchant-manager"
                        return (
                          <tr
                            key={event.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Abrir evento ${shortId(event.id)}`}
                            onClick={() => setSelectedId(event.id)}
                            onKeyDown={(keyEvent) => {
                              if (
                                keyEvent.key === "Enter" ||
                                keyEvent.key === " "
                              ) {
                                keyEvent.preventDefault()
                                setSelectedId(event.id)
                              }
                            }}
                            className="group cursor-pointer align-top outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <td className="whitespace-nowrap px-4 py-4 text-sm">
                              <time
                                dateTime={new Date(
                                  event.created_at * 1000
                                ).toISOString()}
                                className="leading-tight"
                              >
                                <span className="block">
                                  {eventDateFormatter.format(
                                    event.created_at * 1000
                                  )}
                                </span>
                                <span className="numeric mt-1 block text-xs text-muted-foreground">
                                  {eventTimeFormatter.format(
                                    event.created_at * 1000
                                  )}
                                </span>
                              </time>
                            </td>
                            <td className="px-4 py-4">
                              <Badge className={meta?.badgeClass}>
                                {meta?.label ?? "Desconocido"}
                              </Badge>
                              <p className="numeric mt-1 text-xs text-muted-foreground">
                                kind {event.kind}
                              </p>
                            </td>
                            <td className="px-4 py-4">
                              <p className="max-w-[320px] truncate text-sm font-semibold">
                                {summarize(event)}
                              </p>
                              <p className="numeric mt-0.5 max-w-[320px] truncate text-xs text-muted-foreground">
                                {detailSubline(event)}
                              </p>
                            </td>
                            <td className="px-4 py-4">
                              {fromThisApp ? (
                                <Badge variant="outline">merchant-manager</Badge>
                              ) : (
                                <span className="text-sm text-muted-foreground">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-4 text-right">
                              <span className="inline-flex items-center gap-2">
                                <span
                                  className="numeric text-xs text-muted-foreground"
                                  title={event.id}
                                >
                                  {shortId(event.id)}
                                </span>
                                <ChevronRight
                                  className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                                  aria-hidden
                                />
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          <ResponsiveDialog
            open={selectedEvent !== null}
            onOpenChange={(open) => {
              if (!open) setSelectedId(null)
            }}
          >
            <ResponsiveDialogContent className="sm:max-w-2xl">
              {selectedEvent ? (
                <>
                  <ResponsiveDialogHeader className="pr-10">
                    <div className="flex flex-wrap items-center gap-2">
                      <ResponsiveDialogTitle>
                        Evento {shortId(selectedEvent.id)}
                      </ResponsiveDialogTitle>
                      <Badge
                        className={KIND_META[selectedEvent.kind]?.badgeClass}
                      >
                        {KIND_META[selectedEvent.kind]?.label ?? "Desconocido"}
                      </Badge>
                      <Badge variant="outline" className="numeric">
                        kind {selectedEvent.kind}
                      </Badge>
                    </div>
                    <ResponsiveDialogDescription>
                      Publicado{" "}
                      {dateFormatter.format(selectedEvent.created_at * 1000)}
                    </ResponsiveDialogDescription>
                  </ResponsiveDialogHeader>

                  <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface-2 px-3 py-3 font-mono text-[0.6875rem] leading-relaxed">
                    {JSON.stringify(selectedEvent, null, 2)}
                  </pre>

                  <ResponsiveDialogFooter>
                    <Button variant="outline" onClick={copyJson}>
                      <Copy aria-hidden />
                      Copiar JSON
                    </Button>
                    <ResponsiveDialogClose asChild>
                      <Button variant="ghost">Cerrar</Button>
                    </ResponsiveDialogClose>
                  </ResponsiveDialogFooter>
                </>
              ) : null}
            </ResponsiveDialogContent>
          </ResponsiveDialog>

          <div className="mt-6 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
            <p className="rounded-xl border border-border bg-card px-4 py-3">
              <strong className="text-foreground">Qué no aparece acá:</strong>{" "}
              los zap requests (kind 9734) se firman con una clave efímera y van
              directo al proveedor Lightning, y la autorización Blossom (kind
              24242) viaja como header HTTP: ninguno llega a un relay. Los zap
              receipts (kind 9735) los firma el proveedor y viven en Órdenes; tu
              perfil (kind 0) lo publican otras apps.
            </p>
            <p className="rounded-xl border border-border bg-card px-4 py-3">
              <strong className="text-foreground">Versiones:</strong> los relays
              suelen conservar solo la última versión de cada evento
              reemplazable (productos, categorías, relays y config). Las
              versiones viejas desaparecen de esta lista cuando el relay las
              poda.
            </p>
          </div>
        </>
      )}
    </>
  )
}
