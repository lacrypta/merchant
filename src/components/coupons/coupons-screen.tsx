"use client"

import { Lock, Plus, TicketPercent } from "lucide-react"
import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { CouponMintsPanel } from "@/components/coupons/coupon-mints-dialog"
import { CouponWizard } from "@/components/coupons/coupon-wizard"
import {
  CouponMintDialog,
  type MintAttempt,
} from "@/components/coupons/coupon-mint-dialog"
import { ManagerCard } from "@/components/coupons/manager-card"
import { MintersSection } from "@/components/coupons/minters-section"
import { useCouponService } from "@/components/coupons/use-coupon-service"
import { useCoupons, type CouponJson } from "@/components/coupons/use-coupons"
import { PageHeader } from "@/components/shell/page-header"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { describeBenefit } from "@/lib/domain/coupon"
import { cn } from "@/lib/utils"

/**
 * Coupon management.
 *
 * The one screen in this app whose data lives in a database rather than on
 * relays, which shows up in two places: there is no "guardar cambios" step —
 * edits are already true when the dialog closes — and everything here needs the
 * server to be configured, so the empty state has to distinguish "no tenés
 * cupones" from "este servidor no los tiene habilitados".
 */
export function CouponsScreen() {
  const { state } = useAuth()
  const { products } = useCatalog()
  const {
    coupons,
    minters,
    loading,
    error,
    create,
    update,
    remove,
    mint,
    addMinter,
    removeMinter,
    discovery,
    saveDiscovery,
    ready,
  } = useCoupons()

  const service = useCouponService(state.status === "ready" ? state.pubkey : "", {
    stored: discovery,
    saveDiscovery,
  })

  /**
   * Null until the merchant picks one, so the default can follow the service
   * without an effect: derive the tab instead of storing and correcting it.
   * A pick that becomes unreachable — the service was deactivated, or is still
   * loading — falls back rather than showing a locked panel.
   */
  const [picked, setPicked] = React.useState<CouponTab | null>(null)
  const tab: CouponTab =
    picked && (service.isActive || picked === "status")
      ? picked
      : service.isActive
        ? "coupons"
        : "status"
  const setTab = setPicked

  const [viewing, setViewing] = React.useState<CouponJson | null>(null)
  const [editing, setEditing] = React.useState<CouponJson | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [minting, setMinting] = React.useState<MintAttempt | null>(null)
  const [removingCoupon, setRemovingCoupon] = React.useState<CouponJson | null>(null)

  /**
   * Issue one coupon, on the click that asked for it.
   *
   * Deliberately NOT inside the dialog's effect: an effect re-runs on remount,
   * and React's development StrictMode remounts everything once, which minted
   * two coupons per tap and spent two of the merchant's allowance.
   */
  const issue = React.useCallback(
    async (coupon: CouponJson) => {
      setMinting({ coupon, minted: null, error: null })
      try {
        const result = await mint(coupon.id)
        setMinting({ coupon, minted: result, error: null })
      } catch (e) {
        setMinting({
          coupon,
          minted: null,
          error: e instanceof Error ? e.message : "No pudimos emitir el cupón.",
        })
      }
    },
    [mint]
  )

  /**
   * Wall clock, sampled rather than read during render.
   *
   * Reading Date.now() while rendering makes "vencido" depend on when React
   * happened to re-render. A minute is plenty of resolution for an expiry date.
   */
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const titleOf = React.useCallback(
    (d: string) => products.find((p) => p.d === d)?.title,
    [products]
  )

  if (state.status !== "ready") return null

  const active = coupons.filter((c) => c.archivedAt === null)

  return (
    <div className="mx-auto w-full max-w-app px-4 py-6 lg:px-8">
      <PageHeader
        title="Cupones"
        count={ready && !loading && service.isActive ? active.length : undefined}
        description="Descuentos que emitís y que se canjean en tu tienda o en cualquier punto de venta."
        action={
          // Only where it belongs. On "Autorizados" or "Estado" this button
          // would act on a list the merchant is not looking at.
          tab === "coupons" ? (
            <Button onClick={() => setCreating(true)} disabled={!ready || !!error}>
              <Plus className="size-4" aria-hidden />
              Nuevo cupón
            </Button>
          ) : undefined
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as CouponTab)}>
        <TabsList variant="line" className="h-auto w-full justify-start gap-1 p-0">
          {/* Both coupon tabs stay shut until the service is activated: a coupon
              nobody can discover, or a cashier authorised to mint one, are both
              meaningless until the announcement exists. */}
          <TabTrigger value="coupons" disabled={!service.isActive}>
            Cupones
          </TabTrigger>
          <TabTrigger value="minters" disabled={!service.isActive}>
            Autorizados
          </TabTrigger>
          <TabTrigger value="status">
            Estado
            {service.isActive ? null : (
              <span
                aria-label="requiere activación"
                className="size-1.5 rounded-full bg-warning"
              />
            )}
          </TabTrigger>
        </TabsList>

        <TabsContent value="coupons" className="pt-5">
          {error ? (
            <ErrorNotice message={error.message} />
          ) : loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full rounded-2xl" />
              <Skeleton className="h-14 w-full rounded-2xl" />
            </div>
          ) : coupons.length === 0 ? (
            <EmptyState canCreate onCreate={() => setCreating(true)} />
          ) : (
            <CouponTable
              coupons={coupons}
              now={now}
              titleOf={titleOf}
              onOpen={setViewing}
              onEdit={setEditing}
              onMint={(c) => void issue(c)}
              onRemove={setRemovingCoupon}
              onToggleArchived={(c) =>
                void update(c.id, { archived: c.archivedAt === null })
              }
            />
          )}
        </TabsContent>

        <TabsContent value="minters" className="pt-5">
          {error ? (
            <ErrorNotice message={error.message} />
          ) : (
            <MintersSection
              minters={minters}
              onAdd={async (pubkey, label) => {
                await addMinter(pubkey, label)
              }}
              onRemove={removeMinter}
            />
          )}
        </TabsContent>

        <TabsContent value="status" className="pt-5">
          <ManagerCard service={service} />
        </TabsContent>
      </Tabs>

      <ResponsiveDialog
        open={!!viewing}
        onOpenChange={(open) => !open && setViewing(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{viewing?.name}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {viewing?.benefit
                ? describeBenefit(viewing.benefit, titleOf)
                : "Cupones emitidos"}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          {/* Keyed so opening a different coupon refetches instead of showing
              the previous one's list for a frame. */}
          {viewing ? <CouponMintsPanel key={viewing.id} coupon={viewing} /> : null}
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* Keyed so switching which coupon is open resets the fields by
          remounting, rather than a setState in an effect. */}
      <ResponsiveDialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
          }
        }}
      >
        <ResponsiveDialogContent className="sm:max-w-3xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {editing ? "Editar cupón" : "Nuevo cupón"}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {editing
                ? "Los cupones ya emitidos mantienen las condiciones con las que salieron."
                : "Se guarda en este servidor, no en nostr."}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          {creating || editing ? (
            <CouponWizard
              key={editing?.id ?? "new"}
              existing={editing ?? undefined}
              onSubmit={async (input) => {
                if (editing) await update(editing.id, input)
                else await create(input)
                setCreating(false)
                setEditing(null)
              }}
              onCancel={() => {
                setCreating(false)
                setEditing(null)
              }}
            />
          ) : null}
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <CouponMintDialog
        attempt={minting}
        npub={state.npub}
        onClose={() => setMinting(null)}
      />

      <AlertDialog
        open={!!removingCoupon}
        onOpenChange={(open) => !open && setRemovingCoupon(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removingCoupon && removingCoupon.minted > 0
                ? "¿Archivar este cupón?"
                : "¿Eliminar este cupón?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removingCoupon && removingCoupon.minted > 0
                ? `Ya emitiste ${removingCoupon.minted}, así que se archiva en lugar de borrarse: no vas a poder emitir más, y los que están en manos de tus clientes se siguen pudiendo canjear.`
                : "Nunca se emitió, así que se borra del todo."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removingCoupon
                setRemovingCoupon(null)
                if (target) void remove(target.id)
              }}
            >
              {removingCoupon && removingCoupon.minted > 0 ? "Archivar" : "Eliminar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CouponTable({
  coupons,
  now,
  titleOf,
  onOpen,
  onEdit,
  onMint,
  onRemove,
  onToggleArchived,
}: {
  coupons: CouponJson[]
  /** Sampled once per minute by the screen — never read during render. */
  now: number
  titleOf: (d: string) => string | undefined
  onOpen: (c: CouponJson) => void
  onEdit: (c: CouponJson) => void
  onMint: (c: CouponJson) => void
  onRemove: (c: CouponJson) => void
  onToggleArchived: (c: CouponJson) => void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <caption className="sr-only">
            Cupones con su descuento, cuántos se emitieron y cuántos se canjearon
          </caption>
          <thead className="border-b border-border bg-surface-2">
            <tr>
              <Th>Cupón</Th>
              <Th>Descuento</Th>
              <Th align="right">Emitidos</Th>
              <Th align="right">Canjeados</Th>
              <Th>Vence</Th>
              <Th align="right">
                <span className="sr-only">Acciones</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {coupons.map((c) => {
              const archived = c.archivedAt !== null
              const exhausted = c.maxUses !== null && c.minted >= c.maxUses
              const expired = c.expiresAt !== null && c.expiresAt * 1000 <= now
              const mintable = !archived && !exhausted && !expired && !!c.benefit

              return (
                <tr
                  key={c.id}
                  // The row is the way into the issued list. Buttons inside it
                  // stopPropagation so "Editar" does not also open the panel.
                  role="button"
                  tabIndex={0}
                  aria-label={`Ver los cupones emitidos de ${c.name}`}
                  onClick={() => onOpen(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onOpen(c)
                    }
                  }}
                  className={cn(
                    "group cursor-pointer transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-none",
                    archived && "opacity-60"
                  )}
                >
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      {c.description ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {c.description}
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {archived ? <Badge variant="outline">Archivado</Badge> : null}
                        {expired && !archived ? (
                          <Badge variant="outline">Vencido</Badge>
                        ) : null}
                        {exhausted && !archived && !expired ? (
                          <Badge variant="outline">Agotado</Badge>
                        ) : null}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {c.benefit ? (
                      describeBenefit(c.benefit, titleOf)
                    ) : (
                      <span className="text-danger">
                        No pudimos leer este cupón. Editalo para corregirlo.
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    <span className="numeric">
                      {c.minted}
                      {c.maxUses !== null ? (
                        <span className="text-muted-foreground">/{c.maxUses}</span>
                      ) : null}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="numeric">{c.claimed}</span>
                  </Td>
                  <Td>
                    <span className="numeric text-muted-foreground">
                      {c.expiresAt
                        ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(
                            new Date(c.expiresAt * 1000)
                          )
                        : "—"}
                    </span>
                  </Td>
                  <Td align="right">
                    {/* One stop here rather than on four buttons: every control
                        in this cell acts on the row, none of them means "open
                        it". */}
                    <div
                      className="flex flex-wrap justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!mintable}
                        onClick={() => onMint(c)}
                      >
                        Emitir
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onEdit(c)}>
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => (archived ? onToggleArchived(c) : onRemove(c))}
                      >
                        {archived ? "Reactivar" : "Quitar"}
                      </Button>
                    </div>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <td
      className={`px-4 py-3 align-middle text-sm ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </td>
  )
}

function EmptyState({
  canCreate,
  onCreate,
}: {
  canCreate: boolean
  onCreate: () => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-6 py-12 text-center">
      <TicketPercent
        className="mx-auto size-8 text-muted-foreground"
        aria-hidden
      />
      <p className="mt-3 font-medium">Todavía no tenés cupones</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {canCreate
          ? "Creá uno y emitilo cuando quieras: un porcentaje, un monto fijo, un 2x1 o un producto de regalo."
          : "Primero activá el servicio de cupones acá arriba. Después vas a poder crear un porcentaje, un monto fijo, un 2x1 o un producto de regalo."}
      </p>
      {canCreate ? (
        <Button className="mt-4" onClick={onCreate}>
          <Plus className="size-4" aria-hidden />
          Nuevo cupón
        </Button>
      ) : null}
    </div>
  )
}

type CouponTab = "coupons" | "minters" | "status"

/** A tab that says why it is locked instead of just being dead to the touch. */
function TabTrigger({
  value,
  disabled,
  children,
}: {
  value: CouponTab
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <TabsTrigger
      value={value}
      disabled={disabled}
      title={disabled ? "Activá el servicio de cupones para usar esta sección" : undefined}
      className="h-auto flex-none gap-1.5 px-3 py-2.5 text-sm font-semibold"
    >
      {children}
      {disabled ? <Lock className="size-3.5" aria-hidden /> : null}
    </TabsTrigger>
  )
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning"
    >
      {message}
    </p>
  )
}
