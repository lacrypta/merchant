import { NextResponse } from "next/server"

import { normalizeStoreUrl } from "@/lib/domain/woo-config"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { isAllowedWooPath, wooRequest, type WooMethod } from "@/lib/server/woo"

/**
 * The one door to a merchant's WooCommerce store.
 *
 * A browser cannot call the store directly: WooCommerce sends no CORS headers
 * for /wp-json/wc/v3, so every request would fail before it left the tab.
 *
 * Why this is not an open proxy, in order of what actually stops an attacker:
 *  - the path allowlist in lib/server/woo.ts confines this to WooCommerce
 *    product/order/settings endpoints. Without it, `/wp-json/wp/v2/users`
 *    enumerates WordPress accounts through us.
 *  - the SSRF dispatcher validates the CONNECTED socket, so no private or
 *    metadata address is reachable however the hostname resolves.
 *  - https only, enforced when the store URL is normalised.
 *
 * Unlike /api/ln/*, the response body is passed through rather than reduced to
 * an allowlist of fields. That rule existed to stop the endpoint becoming a
 * generic fetch-and-echo oracle; here the path allowlist already does that,
 * and the client genuinely needs whole product and order objects. Reducing
 * them server-side would mean maintaining the same projection twice.
 */
export const runtime = "nodejs"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const NO_STORE = { ...CORS, "Cache-Control": "no-store" }

const METHODS: readonly string[] = ["GET", "POST", "PUT"]

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(request: Request) {
  const limited = rateLimit(`woo-proxy:${clientIp(request)}`, {
    max: 60,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Demasiados pedidos. Probá de nuevo en unos segundos." },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) },
      }
    )
  }

  let body: {
    storeUrl?: unknown
    consumerKey?: unknown
    consumerSecret?: unknown
    path?: unknown
    method?: unknown
    query?: unknown
    body?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json(
      { error: "Cuerpo inválido." },
      { status: 400, headers: NO_STORE }
    )
  }

  const storeUrl =
    typeof body.storeUrl === "string" ? normalizeStoreUrl(body.storeUrl) : null
  const key = typeof body.consumerKey === "string" ? body.consumerKey : ""
  const secret = typeof body.consumerSecret === "string" ? body.consumerSecret : ""
  const path = typeof body.path === "string" ? body.path : ""
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET"

  if (!storeUrl || !key || !secret) {
    return NextResponse.json(
      { error: "Falta la conexión con la tienda." },
      { status: 400, headers: NO_STORE }
    )
  }
  if (!METHODS.includes(method)) {
    return NextResponse.json(
      { error: "Método no permitido." },
      { status: 400, headers: NO_STORE }
    )
  }
  if (!isAllowedWooPath(path)) {
    return NextResponse.json(
      { error: "Ese endpoint no está permitido." },
      { status: 400, headers: NO_STORE }
    )
  }

  // Query values are stringified; anything nested is dropped rather than
  // silently serialised as "[object Object]".
  const query: Record<string, string> = {}
  if (body.query && typeof body.query === "object") {
    for (const [k, v] of Object.entries(body.query as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") query[k] = String(v)
    }
  }

  try {
    const res = await wooRequest({
      storeUrl,
      consumerKey: key,
      consumerSecret: secret,
      path,
      method: method as WooMethod,
      query,
      body: body.body,
    })

    return NextResponse.json(
      {
        status: res.status,
        json: res.json,
        totalPages: res.totalPages,
        total: res.total,
      },
      { headers: NO_STORE }
    )
  } catch {
    // Includes SsrfBlockedError — never leak which internal address was hit.
    return NextResponse.json(
      { error: "No pudimos contactar la tienda." },
      { status: 502, headers: NO_STORE }
    )
  }
}
