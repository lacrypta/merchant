import "server-only"

import { request } from "undici"

import { readJsonBody, ssrfSafeAgent } from "@/lib/server/ssrf"

/**
 * WooCommerce REST API client, server-side only.
 *
 * A DELIBERATE departure from the LNURL proxy's rule that "the browser never
 * names an outbound host". There, the callback URL was derived server-side, so
 * it could be handed back as an opaque signed token. Here the host IS the
 * merchant's own store, typed by the merchant, stored in their own encrypted
 * config — there is nothing to derive it from. So the browser does name it,
 * and the compensating controls are:
 *
 *   1. the rebinding-proof SSRF dispatcher (no private address is reachable),
 *   2. an allowlist of API paths (§ALLOWED_PATH), so this is not a general
 *      fetch oracle,
 *   3. https only, so Basic-auth credentials never cross the wire in clear,
 *   4. rate limits on the routes.
 *
 * The credentials travel on every proxied call. They cannot live in a signed
 * token: `mintToken` authenticates but does NOT encrypt, and its payload is
 * base64url — anyone could read the secret straight out of the token. They are
 * used for the Authorization header and never stored or logged.
 */

/** A products page of 100 does not fit in the 64 KB default. */
export const WOO_MAX_BODY_BYTES = 1024 * 1024

export const WOO_API_PREFIX = "/wp-json/wc/v3/"

/**
 * The only endpoints we will proxy.
 *
 * WordPress mounts far more than WooCommerce under /wp-json — `wp/v2/users`
 * enumerates accounts, and other plugins mount their own routes. Without this
 * an authenticated caller could reach all of it through us.
 */
const ALLOWED_PATH =
  /^\/wp-json\/wc\/v3\/(products(\/\d+)?(\/batch)?|orders(\/\d+)?|settings\/general)$/

export type WooMethod = "GET" | "POST" | "PUT"

export interface WooRequest {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
  path: string
  method: WooMethod
  query?: Record<string, string | number | undefined>
  body?: unknown
}

export interface WooResponse {
  status: number
  json: unknown
  /** From X-WP-TotalPages. 1 when the header is absent. */
  totalPages: number
  total: number | null
}

export class WooPathNotAllowedError extends Error {
  constructor(readonly path: string) {
    super(`Path not allowed: ${path}`)
    this.name = "WooPathNotAllowedError"
  }
}

export function isAllowedWooPath(path: string): boolean {
  return ALLOWED_PATH.test(path)
}

/**
 * Build the outbound URL.
 *
 * The path is validated against the allowlist BEFORE being joined, and joined
 * onto the store origin rather than resolved against it, so a `path` of
 * `//evil.example/x` or `../../` cannot escape the host.
 */
function buildUrl(
  storeUrl: string,
  path: string,
  query: WooRequest["query"]
): URL {
  if (!isAllowedWooPath(path)) throw new WooPathNotAllowedError(path)

  const origin = new URL(storeUrl)
  if (origin.protocol !== "https:") throw new WooPathNotAllowedError(path)

  const url = new URL(`${origin.origin}${path}`)
  // Re-check: a path that survived the regex must still not have moved hosts.
  if (url.origin !== origin.origin) throw new WooPathNotAllowedError(path)

  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  }
  return url
}

function basicAuth(key: string, secret: string): string {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`
}

const toInt = (v: string | string[] | undefined): number | null => {
  const raw = Array.isArray(v) ? v[0] : v
  const n = Number(raw)
  return raw !== undefined && Number.isFinite(n) ? n : null
}

/**
 * One call to a merchant's WooCommerce store.
 *
 * Never throws for an HTTP error — the status comes back so the caller can
 * tell 401 (credentials revoked) from 404 (wrong path) from 500 (their store
 * is broken), each of which needs a different message. Throws only for a
 * refused path or an unreachable host.
 */
export async function wooRequest(req: WooRequest): Promise<WooResponse> {
  const url = buildUrl(req.storeUrl, req.path, req.query)
  const hasBody = req.method !== "GET" && req.body !== undefined

  const res = await request(url.toString(), {
    method: req.method,
    dispatcher: ssrfSafeAgent(),
    headersTimeout: 10_000,
    bodyTimeout: 20_000,
    headers: {
      accept: "application/json",
      authorization: basicAuth(req.consumerKey, req.consumerSecret),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
  })

  const json = await readJsonBody(res.body, WOO_MAX_BODY_BYTES)

  return {
    status: res.statusCode,
    json,
    totalPages: toInt(res.headers["x-wp-totalpages"] as string | undefined) ?? 1,
    total: toInt(res.headers["x-wp-total"] as string | undefined),
  }
}

/**
 * Probe a store: are these credentials good, and what currency does it use?
 *
 * `/settings/general` needs `read` scope and carries `woocommerce_currency`.
 * Orders must be created in the store's own currency — a store configured in
 * ARS that receives an order tagged USD reports nonsense forever after.
 */
export interface WooProbe {
  ok: boolean
  status: number
  storeCurrency?: string
  reason?: "auth" | "not-woocommerce" | "unreachable" | "http"
}

export async function probeStore(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string
): Promise<WooProbe> {
  let res: WooResponse
  try {
    res = await wooRequest({
      storeUrl,
      consumerKey,
      consumerSecret,
      path: `${WOO_API_PREFIX}settings/general`,
      method: "GET",
    })
  } catch {
    // Includes SsrfBlockedError. Never say which address was refused.
    return { ok: false, status: 0, reason: "unreachable" }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: "auth" }
  }
  if (res.status !== 200) {
    return { ok: false, status: res.status, reason: "http" }
  }
  if (!Array.isArray(res.json)) {
    return { ok: false, status: res.status, reason: "not-woocommerce" }
  }

  const currency = res.json.find(
    (s): s is { id: string; value: unknown } =>
      !!s && typeof s === "object" && (s as { id?: unknown }).id === "woocommerce_currency"
  )?.value

  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, status: res.status, reason: "not-woocommerce" }
  }

  return { ok: true, status: res.status, storeCurrency: currency }
}
