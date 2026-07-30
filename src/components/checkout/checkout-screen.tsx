"use client"

import { ArrowLeft, CheckCircle2, Loader2, Zap } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { useCart } from "@/components/cart/cart-provider"
import { RateFreshnessChip } from "@/components/cart/rate-freshness-chip"
import { InvoiceQr } from "@/components/checkout/invoice-qr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Odometer } from "@/components/ui/odometer"
import { Skeleton } from "@/components/ui/skeleton"
import { TickerChip } from "@/components/ui/ticker-chip"
import { decodeInvoice, DEFAULT_EXPIRY_SECONDS } from "@/lib/domain/bolt11"
import type { AppliedCoupon } from "@/lib/domain/coupon"
import { formatPrice } from "@/lib/domain/price"
import {
  QUOTE_TTL_MS,
  buildZapRequestTemplate,
  canonicalItemsHash,
  classifyNostrParam,
  fitZapRequest,
  newOrderCreatedAt,
  planComment,
  reconcilePayee,
  settle,
  signZapRequest,
  toOrderLines,
  verifyPreimage,
  type Invoice,
  type Order,
  type PayeePin,
  type Proof,
} from "@/lib/domain/order"
import { clearOrder, loadOrder, saveOrder } from "@/lib/checkout/order-store"
import { usePaymentWatch } from "@/lib/checkout/use-payment-watch"
import { nowSeconds } from "@/lib/nostr/created-at"
import { DEFAULT_RELAYS, dedupeRelays } from "@/lib/nostr/relays"

interface PayParams {
  min: number
  max: number
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey: string | null
  metadataSha256: string
  /** Where the money goes. Pinned at checkout; see reconcilePayee(). */
  origin: string
  /** Opaque signed token — the raw callback URL never reaches the browser. */
  callback: string
  /** Length of the real callback, for sizing the zap request against it. */
  callbackLength: number
}

type Phase =
  | { k: "loading" }
  | { k: "ready" }
  | { k: "invoicing" }
  | { k: "error"; message: string }

export function CheckoutScreen({
  /**
   * The coupon input, resolved on the server and passed in as an already
   * rendered node. Absent — or null once it resolves — when this shop has not
   * announced coupons pointing at this deployment.
   */
  couponSlot,
}: {
  couponSlot?: React.ReactNode
}) {
  const {
    merchant,
    cart,
    count,
    quote,
    priced,
    coupon,
    removeCoupon,
    rates,
    displayCurrency,
    clear,
    hydrated,
  } = useCart()
  // The shop's own details come from the layout and are known immediately; only
  // the basket and the wallet are still in flight. That is what makes a useful
  // loading screen possible here instead of a blank one.

  const [order, setOrder] = React.useState<Order | null>(null)
  const [params, setParams] = React.useState<PayParams | null>(null)
  const [phase, setPhase] = React.useState<Phase>({ k: "loading" })
  const [preimageInput, setPreimageInput] = React.useState("")
  const [now, setNow] = React.useState(() => Date.now())

  /**
   * Mint a fresh set of pay parameters (and therefore a fresh callback token).
   *
   * Fetched at PAYMENT time, never baked into the ISR'd page: a merchant who
   * just switched wallets must not keep receiving at the old one, and a hung
   * merchant domain must not stall an RSC render.
   *
   * Callable more than once, which is the whole point — the callback token
   * expires after fifteen minutes, and a checkout screen left open on a
   * counter will outlive that routinely.
   */
  const resolveParams = React.useCallback(async (): Promise<PayParams> => {
    if (!merchant.lud16) throw new Error("Este comercio no tiene dirección Lightning.")
    const res = await fetch(
      `/api/ln/resolve?addr=${encodeURIComponent(merchant.lud16)}`,
      { cache: "no-store" }
    )
    const data = (await res.json()) as PayParams & { error?: string }
    if (!res.ok) throw new Error(data.error ?? "La billetera no responde.")
    setParams(data)
    return data
  }, [merchant.lud16])

  /**
   * Restore an in-flight order — but ONLY if it is still this cart's order.
   *
   * An order in progress must survive a refresh or a phone lock with the same
   * id; that is the whole point of persisting it. What must NOT survive is a
   * FINISHED or ABANDONED order outliving the cart that produced it: the
   * screen renders `order.lines`, so restoring blindly meant someone who
   * checked out yesterday, then added different products today, was shown
   * yesterday's items and yesterday's amount. It looked like placeholder
   * data, and it would have charged for the wrong basket.
   *
   * `itemsHash` is exactly the right comparison — it is the hash the zap
   * request already commits to, so "same order" means the same basket by the
   * same definition the protocol uses.
   */
  React.useEffect(() => {
    // The cart comes from localStorage; comparing against it before it has
    // hydrated would discard every order on the first frame.
    if (!hydrated) return

    let cancelled = false
    void (async () => {
      const existing = loadOrder(merchant.pubkey)
      if (cancelled) return

      if (existing) {
        // A paid order is never restored. It is dropped from storage the moment
        // payment lands (see below), so reaching here means a copy survived —
        // another tab, or a session that predates that rule — and showing it
        // would greet the next customer with somebody else's receipt.
        if (existing.status === "paid") {
          clearOrder(merchant.pubkey)
          try {
            await resolveParams()
            if (!cancelled) setPhase({ k: "ready" })
          } catch (e) {
            if (!cancelled) {
              setPhase({
                k: "error",
                message:
                  e instanceof Error ? e.message : "No pudimos contactar a la billetera.",
              })
            }
          }
          return
        }

        const done = existing.status === "manually_confirmed"
        // The coupon is part of the order's identity: it changes the zap
        // request's tags, and therefore the event hash that IS the order number.
        // A restored order carrying a different coupon than the cart would show
        // a total nobody agreed to.
        const sameBasket =
          existing.itemsHash === canonicalItemsHash(toOrderLines(cart.lines)) &&
          (existing.coupon?.nonce ?? null) === (cart.coupon?.nonce ?? null)

        if (sameBasket || (done && cart.lines.length === 0)) {
          // Either the order still matches, or it is a receipt the customer
          // may still be holding up to the cashier.
          setOrder(existing)
        } else {
          clearOrder(merchant.pubkey)
        }
      }

      try {
        await resolveParams()
        if (!cancelled) setPhase({ k: "ready" })
      } catch (e) {
        if (!cancelled) {
          setPhase({
            k: "error",
            message:
              e instanceof Error ? e.message : "No pudimos contactar a la billetera.",
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // `cart.lines` is read once, at restore time; re-running on every cart
    // edit would fight the order that edit is about to create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant.pubkey, resolveParams, hydrated])

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const commit = React.useCallback(
    (next: Order) => {
      setOrder(next)
      saveOrder(merchant.pubkey, next)
    },
    [merchant.pubkey]
  )

  /** Every detector funnels here. `settle` decides precedence; we just store. */
  const onProof = React.useCallback(
    (proof: Proof) => {
      setOrder((current) => {
        if (!current) return current
        const next = settle(current, proof, Date.now())
        // Paid orders leave storage instead of being written back — a later
        // proof for the same order must not put the receipt back where the
        // next customer would find it. Same idempotent-write discipline as
        // saveOrder, so a StrictMode double-invoke is harmless.
        if (next.status === "paid") clearOrder(merchant.pubkey)
        else saveOrder(merchant.pubkey, next)
        return next
      })
    },
    [merchant.pubkey]
  )

  const { lud21Live, receiptLive } = usePaymentWatch(order, onProof)

  const live = order?.invoices.at(-1) ?? null
  const paid = order?.status === "paid"
  const confirmed = order?.status === "manually_confirmed"

  /**
   * A paid order is finished business: forget it, once.
   *
   * Both the cart and the STORED order go. Keeping the order in localStorage
   * meant the next person to open checkout on this phone — the next customer at
   * the same counter — was shown somebody else's receipt, and had to work out
   * that the "Pago recibido" on screen was not theirs.
   *
   * It stays in React state, so whoever just paid keeps the receipt in front of
   * them for as long as they hold the screen up. It is gone on the next visit,
   * which is the point.
   *
   * Deliberately NOT for `manually_confirmed`: that order is still waiting on a
   * payment nobody has verified, and dropping it would lose the only record the
   * customer has that they said they paid.
   */
  const clearedRef = React.useRef(false)
  React.useEffect(() => {
    if (paid && !clearedRef.current) {
      clearedRef.current = true
      clear()
      clearOrder(merchant.pubkey)
    }
  }, [paid, clear, merchant.pubkey])

  /**
   * @param opts.params  Use these instead of state — the expiry retry passes
   *                     freshly-minted ones, which state has not caught up to.
   * @param opts.retried Guard so a persistently-expiring token cannot loop.
   */
  async function createInvoice(
    existing?: Order,
    opts: { params?: PayParams; retried?: boolean } = {}
  ) {
    const active = opts.params ?? params
    if (!active || !quote || !rates) return
    setPhase({ k: "invoicing" })

    try {
      let working = existing ?? order

      /**
       * Redeem the coupon before asking for an invoice.
       *
       * This is the one ordering that cannot be wrong. Claiming AFTER the
       * invoice would mean handing out a discounted invoice that a second till
       * could also honour with the same nonce; claiming here means the worst
       * case is a customer who abandons a paid-for redemption, which costs the
       * merchant one coupon they can re-issue in two taps.
       *
       * Once claimed, `claimedAt` is recorded on the order so a re-quote at a
       * fresh exchange rate — which happens routinely on a checkout screen left
       * open — never tries to spend the nonce twice.
       */
      const activeCoupon = working?.coupon ?? coupon
      let claimed: AppliedCoupon | undefined = activeCoupon ?? undefined

      if (activeCoupon && !activeCoupon.claimedAt) {
        const outcome = await claimCoupon(activeCoupon.nonce)

        if (outcome.kind === "unavailable") {
          setPhase({
            k: "error",
            message: "No pudimos validar el cupón. Probá de nuevo en unos segundos.",
          })
          return
        }

        if (outcome.kind === "spent") {
          // Somebody redeemed it between the shopper applying it and paying.
          // Drop it and make them re-quote: silently charging the full price
          // after showing a discount would be the worse betrayal.
          removeCoupon()
          if (working) {
            clearOrder(merchant.pubkey)
            setOrder(null)
          }
          setPhase({ k: "error", message: outcome.message })
          return
        }

        claimed = { ...activeCoupon, claimedAt: outcome.claimedAt }
      }

      // Mint the order (and therefore the order id) exactly once. Re-invoicing
      // resubmits the SAME signed zap request, which is why the id survives a
      // rate change — the 9734 carries no `amount` tag.
      if (!working) {
        const lines = toOrderLines(cart.lines)
        const relays = dedupeRelays([...DEFAULT_RELAYS]).filter(
          (r) => !r.includes("purplepag.es") && !r.includes("relay.lacrypta.ar")
        )
        const fitted = fitZapRequest({
          merchantPubkey: merchant.pubkey,
          lines,
          relays,
          // Sized against the REAL callback's length, not a placeholder. A
          // stand-in shorter than the merchant's actual URL would let the
          // fitted zap request overflow the budget on the wire — the request
          // is URI-encoded into that URL's query string.
          callbackUrlForSizing: "x".repeat(active.callbackLength || 64),
          amountMsat: quote.msat,
          comment: null,
          createdAt: newOrderCreatedAt(),
          coupon: claimed
            ? { applied: claimed, discount: priced?.entries ?? [] }
            : undefined,
        })
        const zapRequest = signZapRequest(fitted.template)
        const payee: PayeePin = {
          merchantPubkey: merchant.pubkey,
          lud16: merchant.lud16!,
          callbackToken: active.callback,
          callbackOrigin: active.origin,
          nostrPubkey: active.allowsNostr ? active.nostrPubkey : null,
          metadataSha256: active.metadataSha256,
          commentAllowed: active.commentAllowed,
          minSendable: active.min,
          maxSendable: active.max,
        }
        working = {
          v: 1,
          id: zapRequest.id,
          status: "awaiting_invoice",
          createdAt: zapRequest.created_at,
          updatedAt: Date.now(),
          payee,
          lines,
          itemsHash: canonicalItemsHash(lines),
          zapRequest,
          itemsFidelity: fitted.fidelity,
          commentSent: "omitted",
          invoices: [],
          proofs: [],
          anomalies: [],
          ...(claimed ? { coupon: claimed } : {}),
        }
        commit(working)
      } else if (claimed && !working.coupon?.claimedAt) {
        // Re-invoicing an order whose coupon we just redeemed: record the
        // redemption so a third quote does not try to spend the nonce again.
        working = { ...working, coupon: claimed, updatedAt: Date.now() }
        commit(working)
      }

      const plan = planComment(active.commentAllowed, working.id)
      const zapJson = active.allowsNostr ? JSON.stringify(working.zapRequest) : null

      const res = await fetch("/api/ln/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback: active.callback,
          amountMsat: quote.msat,
          comment: plan.comment,
          zapRequest: zapJson,
        }),
      })
      const data = (await res.json()) as {
        pr?: string
        verify?: string | null
        amountMsat?: number
        error?: string
      }
      // The callback token lives 15 minutes; a checkout screen sitting on a
      // counter outlives that routinely. Mint a fresh one and try again
      // rather than making the customer reload — but exactly once, so a
      // server that always 410s cannot spin.
      if (res.status === 410 && !opts.retried) {
        try {
          const fresh = await resolveParams()
          const drift = reconcilePayee(working, fresh)
          if (drift) {
            commit({
              ...working,
              status: "invoice_failed",
              anomalies: [...working.anomalies, drift],
              updatedAt: Date.now(),
            })
            setPhase({
              k: "error",
              message:
                "La billetera del comercio cambió mientras comprabas. Empezá un pedido nuevo por seguridad.",
            })
            return
          }
          await createInvoice(working, { params: fresh, retried: true })
          return
        } catch {
          /* fall through to the generic error below */
        }
      }

      if (!res.ok || !data.pr) {
        commit({ ...working, status: "invoice_failed", updatedAt: Date.now() })
        setPhase({ k: "error", message: data.error ?? "No se pudo generar la factura." })
        return
      }

      const decoded = decodeInvoice(data.pr)
      // An amountless invoice, or one that disagrees with what we asked for,
      // is refused outright: it would let this order settle for one satoshi.
      if (!decoded?.paymentHash || decoded.amountMsat !== quote.msat) {
        commit({ ...working, status: "invoice_failed", updatedAt: Date.now() })
        setPhase({
          k: "error",
          message: "La factura no coincide con el importe. No la pagues.",
        })
        return
      }

      const issuedAt = Date.now()
      const expirySeconds = decoded.expirySeconds || DEFAULT_EXPIRY_SECONDS
      const invoice: Invoice = {
        pr: data.pr,
        paymentHash: decoded.paymentHash,
        amountMsat: quote.msat,
        bolt11AmountMsat: decoded.amountMsat,
        // Anchored at FETCH time, never at the provider's clock, so their skew
        // cannot make our countdown lie.
        hardExpiresAt: issuedAt + expirySeconds * 1000,
        displayExpiresAt: Math.min(
          issuedAt + expirySeconds * 1000,
          issuedAt + QUOTE_TTL_MS
        ),
        issuedAt,
        verifyToken: data.verify ?? null,
        nostrParamStatus: classifyNostrParam(
          decoded.descriptionHash,
          zapJson,
          active.metadataSha256
        ),
        state: "live",
        quote: {
          totalMsat: quote.msat,
          perCurrency: quote.perCurrency,
          rateAsOf: Date.now(),
          quotedAt: issuedAt,
        },
      }

      commit({
        ...working,
        status: "awaiting_payment",
        commentSent: plan.sent,
        invoices: [
          ...working.invoices.map((i) => ({ ...i, state: "superseded" as const })),
          invoice,
        ],
        updatedAt: issuedAt,
      })
      setPhase({ k: "ready" })
    } catch {
      setPhase({ k: "error", message: "No pudimos contactar a la billetera." })
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (paid || confirmed) {
    return (
      <PaidPanel
        order={order!}
        merchantName={merchant.displayName}
        npub={merchant.npub}
        confirmedOnly={confirmed}
      />
    )
  }

  /**
   * The cart is restored from localStorage and then reconciled against the
   * catalog, which now streams in from relays — so for a moment there is no
   * basket to show. Saying "tu pedido está vacío" during that moment is a lie
   * that sends someone back to the shop for items they already chose.
   */
  if (!hydrated) {
    return (
      <Shell npub={merchant.npub}>
        <CheckoutBootstrap merchant={merchant} />
      </Shell>
    )
  }

  if (count === 0 && !order) {
    return (
      <Shell npub={merchant.npub}>
        <p className="text-muted-foreground">Tu pedido está vacío.</p>
      </Shell>
    )
  }

  // Prefer the ORDER's coupon once one exists: the order is what was signed
  // and what the invoice charges for, so after it is minted the cart no longer
  // decides what this screen shows.
  const activeCouponForDisplay = order?.coupon ?? coupon
  const expired = live !== null && now > live.displayExpiresAt
  const secondsLeft = live ? Math.max(0, Math.round((live.displayExpiresAt - now) / 1000)) : 0

  return (
    <Shell npub={merchant.npub}>
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-h1">Pagar</h1>
          <p className="text-sm text-muted-foreground">
            A {merchant.displayName}
            {merchant.lud16 ? (
              <>
                <span aria-hidden> · </span>
                <span className="numeric">{merchant.lud16}</span>
              </>
            ) : null}
          </p>
        </header>

        <section className="enter-pop rounded-2xl border border-border bg-card p-4">
          <ul className="space-y-1.5 text-sm">
            {(order?.lines.length ? order.lines : cart.lines).map((l) => (
              <li key={l.d} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="numeric text-muted-foreground">{l.qty}×</span>{" "}
                  {l.title}
                </span>
                <span className="numeric shrink-0">
                  {formatPrice(l.unitAmount * l.qty, l.currency)}
                </span>
              </li>
            ))}
          </ul>

          {/* The coupon gets its own row rather than being folded into the
              line items: the shopper should be able to see the discount they
              are getting, and so should the merchant reading the receipt. */}
          {activeCouponForDisplay && (priced?.entries.length ?? 0) > 0 ? (
            <div className="mt-3 flex justify-between gap-3 border-t border-border pt-3 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">
                Cupón {activeCouponForDisplay.name}
              </span>
              <span className="numeric shrink-0 text-success">
                −
                {priced!.entries
                  .map((d) => formatPrice(d.amount, d.currency))
                  .join(" − ")}
              </span>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3">
            <span className="font-semibold">Total</span>
            <span className="text-price-lg text-primary">
              <Odometer
                value={live ? live.amountMsat / 1000 : (quote?.sats ?? 0)}
                format={(n) => formatPrice(n, "SAT")}
              />
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <RateFreshnessChip locked={!!live && !expired} />
            {quote && displayCurrency !== "SAT" ? (
              <span className="numeric text-xs text-muted-foreground">
                {quote.perCurrency
                  .map((c) => formatPrice(c.subtotal, c.currency))
                  .join(" + ")}
              </span>
            ) : null}
          </div>
        </section>

        {/* Hidden once an invoice is live: the amount is locked at that point,
            and offering a coupon that cannot change it is a trap. */}
        {!live ? couponSlot : null}

        {phase.k === "error" ? (
          <p
            role="alert"
            className="rounded-xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger"
          >
            {phase.message}
          </p>
        ) : null}

        {!live || expired ? (
          <div className="space-y-3">
            {expired ? (
              <p className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
                La cotización venció. Actualizá el precio para seguir — el número
                de pedido no cambia.
              </p>
            ) : null}
            {/* The wallet round trip has no knowable length, so this says
                "working" rather than inventing a percentage. It sits where the
                button will be, so nothing moves when it is replaced. */}
            {phase.k === "loading" ? (
              <LoadingBar label="Conectando con la billetera del comercio…" />
            ) : null}

            <Button
              fullWidth
              disabled={phase.k === "invoicing" || phase.k === "loading" || !quote}
              onClick={() => void createInvoice(order ?? undefined)}
            >
              {phase.k === "invoicing" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Generando factura…
                </>
              ) : (
                <>
                  <Zap className="size-4" aria-hidden />
                  {expired ? "Actualizar precio" : "Generar factura"}
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <InvoiceQr pr={live.pr} />

            <div className="flex flex-wrap items-center justify-center gap-2 text-center">
              <TickerChip tone={secondsLeft < 60 ? "warning" : "neutral"}>
                Vence en {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, "0")}
              </TickerChip>
              {lud21Live ? <TickerChip>Verificando pago…</TickerChip> : null}
              {receiptLive ? <TickerChip>Escuchando recibo</TickerChip> : null}
            </div>

            {!lud21Live && !receiptLive ? (
              <p className="text-center text-xs text-muted-foreground">
                Esta billetera no permite confirmar el pago automáticamente.
                Avisanos cuando hayas pagado.
              </p>
            ) : null}

            <ManualConfirm
              order={order!}
              paymentHash={live.paymentHash}
              issuedAt={live.issuedAt}
              now={now}
              preimage={preimageInput}
              setPreimage={setPreimageInput}
              onProof={onProof}
            />
          </div>
        )}

        {order ? (
          <p className="numeric truncate-middle text-center text-xs text-muted-foreground">
            Pedido {order.id}
          </p>
        ) : null}
      </div>
    </Shell>
  )
}

type ClaimOutcome =
  | { kind: "claimed"; claimedAt: number }
  /** Already redeemed, or expired — the coupon has to come off the order. */
  | { kind: "spent"; message: string }
  /** We could not reach the service. Retryable; the nonce is untouched. */
  | { kind: "unavailable" }

/**
 * Redeem a nonce.
 *
 * `status: "claimed"` from the server means somebody else got there first —
 * including, possibly, this same browser on a previous attempt whose response we
 * never saw. Either way the coupon is gone and the shopper needs a fresh quote,
 * so both collapse into "spent".
 */
async function claimCoupon(nonce: string): Promise<ClaimOutcome> {
  try {
    const res = await fetch("/api/coupons/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      cache: "no-store",
    })
    const data = (await res.json()) as {
      status?: string
      claimedAt?: number | null
      error?: string
    }

    if (res.status === 404 || res.status === 410) {
      return {
        kind: "spent",
        message: data.error ?? "Ese cupón ya no se puede usar. Generá el pedido de nuevo.",
      }
    }
    if (!res.ok) return { kind: "unavailable" }

    if (data.status === "success") {
      return { kind: "claimed", claimedAt: data.claimedAt ?? nowSeconds() }
    }
    if (data.status === "claimed") {
      return {
        kind: "spent",
        message: "Ese cupón ya fue usado. Generá el pedido de nuevo.",
      }
    }
    return { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

function ManualConfirm({
  order,
  paymentHash,
  issuedAt,
  now,
  preimage,
  setPreimage,
  onProof,
}: {
  order: Order
  paymentHash: string
  issuedAt: number
  now: number
  preimage: string
  setPreimage: (v: string) => void
  onProof: (p: Proof) => void
}) {
  const [showPreimage, setShowPreimage] = React.useState(false)
  // Thirty seconds: long enough that nobody taps it reflexively before the
  // wallet has even opened.
  const enabled = now - issuedAt > 30_000
  const valid = verifyPreimage(preimage.trim(), paymentHash)

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={() =>
            onProof({ kind: "manual", at: Date.now(), paymentHash: null, source: "buyer" })
          }
        >
          Ya pagué
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowPreimage((v) => !v)}
        >
          Pegar preimage
        </Button>
      </div>

      {showPreimage ? (
        <div className="space-y-2">
          <Input
            value={preimage}
            onChange={(e) => setPreimage(e.target.value)}
            placeholder="preimage (64 caracteres hex)"
            className="numeric"
            aria-invalid={preimage.length > 0 && !valid}
          />
          <p className="text-xs text-muted-foreground">
            Si tu billetera te muestra el preimage, esto confirma el pago sin
            depender de nadie más — ni del comercio, ni de los relays, ni de
            nosotros.
          </p>
          <Button
            size="sm"
            fullWidth
            disabled={!valid}
            onClick={() =>
              onProof({
                kind: "preimage-verified",
                at: Date.now(),
                paymentHash,
                preimage: preimage.trim().toLowerCase(),
                source: "buyer",
              })
            }
          >
            {valid ? "Confirmar pago" : "Preimage inválido"}
          </Button>
        </div>
      ) : null}

      {order.anomalies.length > 0 ? (
        <p className="text-center text-xs text-warning">
          {order.anomalies.length} advertencia
          {order.anomalies.length === 1 ? "" : "s"} en este pedido.
        </p>
      ) : null}
    </div>
  )
}

function PaidPanel({
  order,
  merchantName,
  npub,
  confirmedOnly,
}: {
  order: Order
  merchantName: string
  npub: string
  confirmedOnly: boolean
}) {
  const paidMsat = order.invoices.find((i) => i.state === "settled")?.amountMsat
  return (
    <Shell npub={npub}>
      <div className="space-y-5 text-center">
        <div
          className={`mx-auto grid size-16 place-items-center rounded-full ${
            confirmedOnly ? "bg-warning-bg text-warning" : "bg-primary text-primary-foreground"
          }`}
        >
          {confirmedOnly ? (
            <Loader2 className="size-8 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="size-8" aria-hidden />
          )}
        </div>

        <div>
          <h1 className="text-h1">
            {confirmedOnly ? "Esperando confirmación" : "Pago recibido"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {confirmedOnly
              ? "Mostrale el comprobante de tu billetera al comercio."
              : `Le pagaste a ${merchantName}.`}
          </p>
        </div>

        {paidMsat ? (
          <p className="numeric text-price-lg text-primary">
            {formatPrice(paidMsat / 1000, "SAT")}
          </p>
        ) : null}

        <ul className="mx-auto max-w-sm space-y-1 text-left text-sm">
          {order.lines.map((l) => (
            <li key={l.d} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="numeric text-muted-foreground">{l.qty}×</span> {l.title}
              </span>
              <span className="numeric shrink-0 text-muted-foreground">
                {formatPrice(l.unitAmount * l.qty, l.currency)}
              </span>
            </li>
          ))}
        </ul>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="numeric truncate-middle">Pedido {order.id}</p>
          {order.proofs.find((p) => p.preimage) ? (
            <p className="numeric truncate-middle">
              Preimage {order.proofs.find((p) => p.preimage)!.preimage}
            </p>
          ) : null}
        </div>

        {/* Deliberately no auto-navigation: the customer has to be able to
            hold this screen up to whoever is behind the counter. */}
        <Button variant="outline" asChild>
          <Link href={`/s/${npub}`}>Volver a la tienda</Link>
        </Button>
      </div>
    </Shell>
  )
}

function Shell({ npub, children }: { npub: string; children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto w-full max-w-form flex-1 px-4 py-8">
      <Link
        href={`/s/${npub}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Seguir comprando
      </Link>
      {children}
    </main>
  )
}

export { clearOrder, buildZapRequestTemplate }

/**
 * A bar for a wait whose length we cannot know.
 *
 * Every wait on this screen is somebody else's network: a relay fan-out, a
 * merchant's LNURL host. A percentage would be invented, and an invented
 * percentage that sticks at 80% is worse than an honest animation.
 */
function LoadingBar({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        {label}
      </p>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className="bar-indeterminate h-full w-1/3 rounded-full bg-primary" />
      </div>
    </div>
  )
}

/**
 * The checkout before the basket has landed.
 *
 * Deliberately NOT a blank screen: the shop is already known, so its name goes
 * up immediately and only the lines are drawn as placeholders. Same card, same
 * paddings, same total row as the real summary, so the swap is a fill rather
 * than a jump.
 */
function CheckoutBootstrap({ merchant }: { merchant: { displayName: string } }) {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-h1">Pagar</h1>
        <p className="text-sm text-muted-foreground">A {merchant.displayName}</p>
      </header>

      <section
        aria-busy="true"
        className="enter-pop rounded-2xl border border-border bg-card p-4"
      >
        <div className="space-y-2.5">
          {[0, 1].map((i) => (
            <div key={i} className="flex justify-between gap-3">
              <Skeleton className="h-4 w-40 max-w-[60%]" />
              <Skeleton className="h-4 w-16 shrink-0" />
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-border pt-3">
          <span className="font-semibold">Total</span>
          <Skeleton className="h-7 w-28" />
        </div>
      </section>

      <LoadingBar label="Cargando tu pedido…" />
    </div>
  )
}
