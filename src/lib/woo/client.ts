import type { WooConnection } from "@/lib/domain/woo-config"

/**
 * Browser-side WooCommerce client.
 *
 * Everything goes through /api/woo/proxy — the store sends no CORS headers for
 * /wp-json/wc/v3, so a direct call from the tab fails before it leaves.
 */

/** Only the fields we actually read. WooCommerce products carry ~40 more. */
export interface WooProduct {
  id: number
  name: string
  sku: string
  status: string
  description: string
  short_description: string
  /** Read-only on Woo's side; `regular_price` is the writable one. */
  price: string
  regular_price: string
  manage_stock: boolean
  stock_quantity: number | null
  stock_status: string
  images: { id: number; src: string; alt?: string }[]
  categories: { id: number; name: string; slug: string }[]
}

export interface WooOrderLineItemInput {
  product_id: number
  quantity: number
  /** Strings, per the API. Set to pin historical pricing. */
  subtotal?: string
  total?: string
}

export interface WooOrderInput {
  status?: string
  currency: string
  set_paid?: boolean
  payment_method?: string
  payment_method_title?: string
  transaction_id?: string
  customer_note?: string
  meta_data?: { key: string; value: string }[]
  line_items: WooOrderLineItemInput[]
}

export interface WooOrder {
  id: number
  number: string
  status: string
  total: string
  currency: string
  date_created: string
  meta_data?: { key: string; value: unknown }[]
}

export class WooApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = "WooApiError"
  }
}

interface ProxyResult {
  status: number
  json: unknown
  totalPages: number
  total: number | null
}

/** WooCommerce error bodies are `{code, message, data:{status}}`. */
function errorFrom(status: number, json: unknown): WooApiError {
  const body = (json ?? {}) as { code?: unknown; message?: unknown }
  const raw = typeof body.message === "string" ? body.message : ""
  // Their messages are HTML ("<strong>Error:</strong> …").
  const message = raw.replace(/<[^>]*>/g, "").trim()

  if (status === 401 || status === 403) {
    return new WooApiError(
      status,
      "La tienda rechazó la clave. Puede que la hayan revocado.",
      typeof body.code === "string" ? body.code : undefined
    )
  }
  return new WooApiError(
    status,
    message || `La tienda respondió ${status}.`,
    typeof body.code === "string" ? body.code : undefined
  )
}

async function call(
  connection: WooConnection,
  path: string,
  init: {
    method?: "GET" | "POST" | "PUT"
    query?: Record<string, string | number | undefined>
    body?: unknown
  } = {}
): Promise<ProxyResult> {
  const res = await fetch("/api/woo/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      storeUrl: connection.storeUrl,
      consumerKey: connection.consumerKey,
      consumerSecret: connection.consumerSecret,
      path,
      method: init.method ?? "GET",
      query: init.query,
      body: init.body,
    }),
  })

  const data = (await res.json()) as ProxyResult & { error?: string }
  if (!res.ok) throw new WooApiError(res.status, data.error ?? "No pudimos contactar la tienda.")
  if (data.status >= 400) throw errorFrom(data.status, data.json)
  return data
}

/** WordPress caps per_page at 100 regardless of what you ask for. */
export const WOO_PAGE_SIZE = 100

/** Refuses to loop forever if a store reports a bogus X-WP-TotalPages. */
const MAX_PAGES = 100

export interface FetchProductsOptions {
  /** ISO-8601. Only products touched since then — for incremental stock sync. */
  modifiedAfter?: string
  onProgress?: (loaded: number, total: number | null) => void
  signal?: AbortSignal
}

export async function fetchAllProducts(
  connection: WooConnection,
  opts: FetchProductsOptions = {}
): Promise<WooProduct[]> {
  const out: WooProduct[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (opts.signal?.aborted) break

    const res = await call(connection, "/wp-json/wc/v3/products", {
      query: {
        per_page: WOO_PAGE_SIZE,
        page,
        status: "publish",
        orderby: "id",
        order: "asc",
        modified_after: opts.modifiedAfter,
      },
    })

    if (!Array.isArray(res.json)) break
    out.push(...(res.json as WooProduct[]))
    opts.onProgress?.(out.length, res.total)

    if (page >= res.totalPages || res.json.length === 0) break
  }

  return out
}

/** Resolve a SKU to a WooCommerce product id. Null when nothing matches. */
export async function findProductBySku(
  connection: WooConnection,
  sku: string
): Promise<WooProduct | null> {
  const res = await call(connection, "/wp-json/wc/v3/products", {
    query: { sku, per_page: 1 },
  })
  if (!Array.isArray(res.json) || res.json.length === 0) return null
  return res.json[0] as WooProduct
}

/** Write a SKU back to a Woo product that had none. */
export async function setProductSku(
  connection: WooConnection,
  productId: number,
  sku: string
): Promise<void> {
  await call(connection, `/wp-json/wc/v3/products/${productId}`, {
    method: "PUT",
    body: { sku },
  })
}

export async function createOrder(
  connection: WooConnection,
  order: WooOrderInput
): Promise<WooOrder> {
  const res = await call(connection, "/wp-json/wc/v3/orders", {
    method: "POST",
    body: order,
  })
  return res.json as WooOrder
}

/**
 * Recent orders, for the duplicate-recovery scan.
 *
 * The API cannot filter by meta_data, so recovering from a crash between
 * "Woo created the order" and "we published the record" means reading orders
 * back and looking at their meta ourselves.
 */
export async function fetchOrdersAfter(
  connection: WooConnection,
  afterIso: string,
  maxPages = 5
): Promise<WooOrder[]> {
  const out: WooOrder[] = []

  for (let page = 1; page <= maxPages; page++) {
    const res = await call(connection, "/wp-json/wc/v3/orders", {
      query: {
        per_page: WOO_PAGE_SIZE,
        page,
        after: afterIso,
        orderby: "date",
        order: "asc",
      },
    })
    if (!Array.isArray(res.json)) break
    out.push(...(res.json as WooOrder[]))
    if (page >= res.totalPages || res.json.length === 0) break
  }

  return out
}
