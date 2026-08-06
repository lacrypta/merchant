"use client"

import { Ban, Loader2, TicketX } from "lucide-react"
import * as React from "react"

import type { CouponJson, MintJson } from "@/components/coupons/use-coupons"
import { useCouponMints } from "@/components/coupons/use-coupons"
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
import { CopyButton } from "@/components/ui/copy-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Pager } from "@/components/ui/pager"
import { Skeleton } from "@/components/ui/skeleton"
import { describeBenefit, type Benefit } from "@/lib/domain/coupon"
import { cn } from "@/lib/utils"

/** Rows per page. The dialog cannot grow, so this is what fits without scrolling it. */
const PAGE_SIZE = 10

/**
 * Everything issued for one coupon: when it went out, who issued it, whether it
 * was redeemed — and the way to cancel one that has not been.
 *
 * The merchant needs this the moment something goes wrong: a QR sent to the
 * wrong customer, a cashier who tapped "Emitir" twice, a promo called off. Up
 * to now those coupons were simply out there, valid, with no way to take them
 * back.
 */
export function CouponMintsPanel({
  coupon,
  titleOf,
  now,
}: {
  coupon: CouponJson
  /** Resolves a product `d` to its catalog title, for the conditions block. */
  titleOf?: (d: string) => string | undefined
  /** Sampled by the screen once a minute — never read during render. */
  now: number
}) {
  const { mints, loading, error, voidMint } = useCouponMints(coupon.id)
  const [confirming, setConfirming] = React.useState<MintJson | null>(null)
  const [voiding, setVoiding] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)

  // Counted over ALL of them, not the page: these are the answer to "how many
  // are still out there", which a page of ten cannot give.
  const live = mints.filter((m) => m.status === "minted").length
  const claimed = mints.filter((m) => m.status === "claimed").length
  const voided = mints.filter((m) => m.status === "voided").length

  /**
   * A coupon handed out all month has hundreds of these, and the dialog is a
   * dialog — it cannot grow past the viewport. Clamped rather than reset, so
   * voiding the last issuance on the final page steps back a page instead of
   * showing an empty list.
   */
  const pageCount = Math.max(1, Math.ceil(mints.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageMints = mints.slice(pageStart, pageStart + PAGE_SIZE)

  async function handleVoid(mint: MintJson) {
    setActionError(null)
    setVoiding(mint.nonce)
    try {
      await voidMint(mint.nonce)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "No pudimos anular ese cupón.")
    } finally {
      setVoiding(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <CouponSummary coupon={coupon} titleOf={titleOf} now={now} />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-5">
        <CouponSummary coupon={coupon} titleOf={titleOf} now={now} />
        <p role="alert" className="text-sm text-warning">
          {error.message}
        </p>
      </div>
    )
  }

  if (mints.length === 0) {
    return (
      <div className="space-y-5">
        <CouponSummary coupon={coupon} titleOf={titleOf} now={now} />
        <div className="rounded-2xl border border-border bg-surface-2 px-6 py-10 text-center">
          <TicketX className="mx-auto size-7 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-medium">Todavía no emitiste ninguno</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Cuando toques «Emitir», cada cupón que entregues aparece acá con su
            estado.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <CouponSummary coupon={coupon} titleOf={titleOf} now={now} />

      <div className="flex flex-wrap gap-2 text-xs">
        <Tally label="Sin usar" value={live} tone="live" />
        <Tally label="Canjeados" value={claimed} tone="claimed" />
        {voided > 0 ? <Tally label="Anulados" value={voided} tone="voided" /> : null}
      </div>

      {actionError ? (
        <p role="alert" className="text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border">
        <ul className="divide-y divide-border">
          {pageMints.map((mint) => (
            <li
              key={mint.nonce}
              className="flex flex-wrap items-center justify-between gap-3 bg-card px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-1.5">
                  <span className="numeric truncate text-sm">{mint.nonce}</span>
                  <CopyButton label="Copiar el código del cupón" value={mint.nonce} />
                </p>
                <p className="text-xs text-muted-foreground">
                  <MintTimeline mint={mint} />
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={mint.status} />
                {mint.status === "minted" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-danger"
                    disabled={voiding === mint.nonce}
                    onClick={() => setConfirming(mint)}
                  >
                    {voiding === mint.nonce ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Ban className="size-4" aria-hidden />
                    )}
                    Anular
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <Pager
          page={currentPage}
          pageCount={pageCount}
          onPage={setPage}
          label="Paginación de cupones emitidos"
          className="bg-surface-2"
        />
      </div>

      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Anular este cupón emitido?</AlertDialogTitle>
            <AlertDialogDescription>
              Quien lo tenga no va a poder canjearlo: al escanearlo le va a decir
              que fue anulado. Se libera un lugar del máximo, así que podés emitir
              otro en su lugar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming
                setConfirming(null)
                if (target) void handleVoid(target)
              }}
            >
              Anular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The coupon itself: what it gives, on what, and until when.
 *
 * The list of issued codes below is useless without it — "anular este cupón"
 * needs the merchant to know which promo they are looking at, and the terms are
 * exactly what they came to check before handing another one out. Everything
 * here is already in `CouponJson`; it costs no request.
 */
function CouponSummary({
  coupon,
  titleOf,
  now,
}: {
  coupon: CouponJson
  titleOf?: (d: string) => string | undefined
  now: number
}) {
  const expired = coupon.expiresAt !== null && coupon.expiresAt * 1000 <= now
  const exhausted = coupon.maxUses !== null && coupon.minted >= coupon.maxUses
  const scope = coupon.benefit ? benefitProducts(coupon.benefit) : []
  const name = (d: string) => titleOf?.(d) ?? `Producto ${d.slice(0, 8)}…`

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        {coupon.image ? (
          // Arbitrary Blossom hosts cannot go through next/image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coupon.image}
            alt=""
            className="size-14 shrink-0 rounded-xl object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-semibold">
            {coupon.benefit ? (
              describeBenefit(coupon.benefit, titleOf)
            ) : (
              <span className="text-danger">
                No pudimos leer las condiciones de este cupón.
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {coupon.archivedAt !== null ? (
              <Badge variant="outline">Archivado</Badge>
            ) : null}
            {expired ? (
              <Badge variant="outline" className="border-warning/40 text-warning">
                Vencido
              </Badge>
            ) : null}
            {exhausted && !expired ? <Badge variant="outline">Agotado</Badge> : null}
          </div>
        </div>
      </div>

      {scope.length > 0 ? (
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Aplica a
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {scope.map((item) => (
              <li key={`${item.d}-${item.note}`} className="truncate">
                {name(item.d)}
                {item.note ? (
                  <span className="text-muted-foreground"> · {item.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Aplica a todo el catálogo.</p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 sm:grid-cols-4">
        <Field label="Emitidos">
          <span className="numeric">
            {coupon.minted}
            {coupon.maxUses !== null ? ` de ${coupon.maxUses}` : ""}
          </span>
          {coupon.maxUses === null ? (
            <span className="text-muted-foreground"> · sin límite</span>
          ) : null}
        </Field>
        <Field label="Canjeados">
          <span className="numeric">{coupon.claimed}</span>
        </Field>
        <Field label="Vence">
          {coupon.expiresAt === null ? (
            <span className="text-muted-foreground">Sin vencimiento</span>
          ) : (
            <time dateTime={new Date(coupon.expiresAt * 1000).toISOString()}>
              {onlyDate(coupon.expiresAt)}
            </time>
          )}
        </Field>
        <Field label="Creado">{onlyDate(coupon.createdAt)}</Field>
      </dl>

      {/* Archiving is the one state whose consequence is not obvious from its
          name, and getting it backwards means either honouring nothing or
          re-issuing a promo that was called off. */}
      {coupon.archivedAt !== null ? (
        <p className="text-xs text-muted-foreground">
          Archivado: no se pueden emitir nuevos, pero los que ya entregaste se
          siguen canjeando.
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="numeric truncate-middle">{coupon.id}</span>
        <CopyButton label="Copiar el ID del cupón" value={coupon.id} />
      </p>
    </section>
  )
}

/** The products a benefit names, with the role each one plays in it. */
function benefitProducts(benefit: Benefit): { d: string; note: string }[] {
  switch (benefit.type) {
    case "percent":
    case "fixed":
    case "multibuy":
      return (benefit.productDs ?? []).map((d) => ({ d, note: "" }))
    case "buyXgetY":
      return [
        { d: benefit.buyProductD, note: "hay que comprarlo" },
        { d: benefit.giftProductD, note: "va gratis" },
      ]
    case "freeItems":
      return benefit.items.map((i) => ({ d: i.d, note: `${i.qty} gratis` }))
  }
}

function onlyDate(unix: number) {
  return new Date(unix * 1000).toLocaleDateString("es-AR", { dateStyle: "medium" })
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  )
}

function MintTimeline({ mint }: { mint: MintJson }) {
  const when = (unix: number) => new Date(unix * 1000).toLocaleString("es-AR")
  if (mint.status === "claimed" && mint.claimedAt) {
    return <>Canjeado el {when(mint.claimedAt)}</>
  }
  if (mint.status === "voided" && mint.voidedAt) {
    return <>Anulado el {when(mint.voidedAt)}</>
  }
  return <>Emitido el {when(mint.mintedAt)}</>
}

function StatusBadge({ status }: { status: MintJson["status"] }) {
  const map = {
    minted: { label: "Sin usar", className: "border-border text-muted-foreground" },
    claimed: {
      label: "Canjeado",
      className: "border-success/40 bg-success-bg text-success",
    },
    voided: { label: "Anulado", className: "border-danger/40 bg-danger-bg text-danger" },
  }[status]

  return (
    <Badge variant="outline" className={map.className}>
      {map.label}
    </Badge>
  )
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "live" | "claimed" | "voided"
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        tone === "claimed"
          ? "border-success/40 bg-success-bg text-success"
          : tone === "voided"
            ? "border-danger/40 bg-danger-bg text-danger"
            : "border-border text-muted-foreground"
      )}
    >
      <span className="numeric font-semibold">{value}</span>
      {label}
    </span>
  )
}
