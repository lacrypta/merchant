/**
 * What has already been pushed to WooCommerce.
 *
 * This is the ONLY thing standing between a merchant and a second copy of
 * every order in their books: the WooCommerce REST API has no idempotency
 * mechanism and cannot filter `/orders` by `meta_data`, so we cannot ask it
 * "did you already get this one?" in the general case.
 *
 * Stored as a SEPARATE kind-30078 event from the credentials, so a sync — which
 * happens constantly — never rewrites the event holding the API secret.
 */

/** Our `d` tag for the sync record. */
export const WOO_SYNC_D = "lacrypta.merchant/woocommerce/sync"

/** A nostr order (by zap receipt id) and the WooCommerce order it became. */
export interface WooOrderLink {
  /** Zap receipt event id. */
  r: string
  /** WooCommerce order id. */
  w: number
  /** Receipt created_at, unix seconds. Drives the watermark. */
  at: number
}

/** A nostr product and its WooCommerce twin. */
export interface WooProductLink {
  /** Product `d` tag. */
  d: string
  sku: string
  /** WooCommerce product id. Re-resolvable from the SKU; cached to save calls. */
  w: number
}

export interface WooSyncState {
  v: 1
  /**
   * Every receipt at or before this unix second is already handled.
   *
   * Exists so the record does not grow without bound. A plain size cap would
   * be actively dangerous: dropping the oldest entries would make those orders
   * look unsynced and they would be created in WooCommerce a second time.
   */
  syncedThrough: number
  /** Links for receipts AFTER the watermark. */
  orders: WooOrderLink[]
  products: WooProductLink[]
}

export const EMPTY_SYNC_STATE: WooSyncState = {
  v: 1,
  syncedThrough: 0,
  orders: [],
  products: [],
}

/** Past this many tracked orders the event starts crowding relay size limits. */
export const SYNC_STATE_WARN_AT = 1200

export function parseWooSyncState(plaintext: string): WooSyncState {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return EMPTY_SYNC_STATE
  }

  if (!raw || typeof raw !== "object") return EMPTY_SYNC_STATE
  const s = raw as Partial<WooSyncState>
  // Unknown version: start over rather than guess. Losing the record costs a
  // duplicate-scan against WooCommerce; misreading it costs duplicate orders.
  if (s.v !== 1) return EMPTY_SYNC_STATE

  return {
    v: 1,
    syncedThrough:
      typeof s.syncedThrough === "number" && Number.isFinite(s.syncedThrough)
        ? s.syncedThrough
        : 0,
    orders: Array.isArray(s.orders)
      ? s.orders.filter(
          (o): o is WooOrderLink =>
            !!o &&
            typeof o.r === "string" &&
            typeof o.w === "number" &&
            typeof o.at === "number"
        )
      : [],
    products: Array.isArray(s.products)
      ? s.products.filter(
          (p): p is WooProductLink =>
            !!p &&
            typeof p.d === "string" &&
            typeof p.sku === "string" &&
            typeof p.w === "number"
        )
      : [],
  }
}

export function serializeWooSyncState(s: WooSyncState): string {
  return JSON.stringify(s)
}

/** Has this receipt already become a WooCommerce order? */
export function isOrderSynced(
  state: WooSyncState,
  receiptId: string,
  receiptAt: number
): boolean {
  if (receiptAt > 0 && receiptAt <= state.syncedThrough) return true
  return state.orders.some((o) => o.r === receiptId)
}

export function wooOrderIdFor(
  state: WooSyncState,
  receiptId: string
): number | undefined {
  return state.orders.find((o) => o.r === receiptId)?.w
}

/** Record a created order. Idempotent: re-recording the same receipt is a no-op. */
export function recordOrderSync(
  state: WooSyncState,
  link: WooOrderLink
): WooSyncState {
  if (state.orders.some((o) => o.r === link.r)) return state
  return { ...state, orders: [...state.orders, link] }
}

export function skuFor(state: WooSyncState, d: string): string | undefined {
  return state.products.find((p) => p.d === d)?.sku
}

export function wooProductIdForSku(
  state: WooSyncState,
  sku: string
): number | undefined {
  const needle = sku.trim().toLowerCase()
  return state.products.find((p) => p.sku.trim().toLowerCase() === needle)?.w
}

/** Upsert a product link, keyed on the product `d`. */
export function recordProductSync(
  state: WooSyncState,
  link: WooProductLink
): WooSyncState {
  const rest = state.products.filter((p) => p.d !== link.d)
  return { ...state, products: [...rest, link] }
}

/**
 * Move the watermark forward and drop the links it now covers.
 *
 * @param oldestUnsynced Unix seconds of the EARLIEST receipt still not synced,
 *   or Infinity when every known order is done. The watermark must never reach
 *   it: passing an unsynced order would mark it handled forever and it would
 *   never reach WooCommerce. That includes orders we skipped on purpose — a
 *   skip is "not yet", not "never".
 */
export function compactSyncState(
  state: WooSyncState,
  oldestUnsynced: number
): WooSyncState {
  const newest = state.orders.reduce((max, o) => Math.max(max, o.at), 0)
  const ceiling = Number.isFinite(oldestUnsynced)
    ? Math.min(newest, oldestUnsynced - 1)
    : newest
  const watermark = Math.max(state.syncedThrough, ceiling)
  if (watermark <= state.syncedThrough) return state

  return {
    ...state,
    syncedThrough: watermark,
    orders: state.orders.filter((o) => o.at > watermark),
  }
}
