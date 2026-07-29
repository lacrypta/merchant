import { NextResponse } from "next/server"

import { normalizeStoreUrl } from "@/lib/domain/woo-config"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { probeStore } from "@/lib/server/woo"

/**
 * Verify a WooCommerce connection before we store it.
 *
 * The merchant's store URL is arbitrary input, so this goes out through the
 * rebinding-proof SSRF dispatcher. It exists mostly to fail EARLY and
 * specifically: without it, a typo'd domain or a revoked key surfaces later as
 * a mystery during an import, halfway through touching their catalog.
 *
 * The credentials are used for one probe and never stored here — the only copy
 * lives NIP-44-encrypted in the merchant's own kind-30078 event.
 */
export const runtime = "nodejs"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const NO_STORE = { ...CORS, "Cache-Control": "no-store" }

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(request: Request) {
  const limited = rateLimit(`woo-connect:${clientIp(request)}`, {
    max: 10,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Demasiados intentos. Probá de nuevo en unos segundos." },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) },
      }
    )
  }

  let body: { storeUrl?: unknown; consumerKey?: unknown; consumerSecret?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json(
      { error: "Cuerpo inválido." },
      { status: 400, headers: NO_STORE }
    )
  }

  // Shape checks before any network call, so the SSRF guard is the second
  // line of defence rather than the first.
  const storeUrl =
    typeof body.storeUrl === "string" ? normalizeStoreUrl(body.storeUrl) : null
  if (!storeUrl) {
    return NextResponse.json(
      { error: "La dirección de la tienda tiene que ser una URL https válida." },
      { status: 400, headers: NO_STORE }
    )
  }

  const key = typeof body.consumerKey === "string" ? body.consumerKey.trim() : ""
  const secret =
    typeof body.consumerSecret === "string" ? body.consumerSecret.trim() : ""
  if (!key || !secret) {
    return NextResponse.json(
      { error: "Faltan la clave y el secreto de la API." },
      { status: 400, headers: NO_STORE }
    )
  }

  try {
    const probe = await probeStore(storeUrl, key, secret)

    if (!probe.ok) {
      // Each of these needs a different next step from the merchant, so they
      // must not collapse into one message: a revoked key, a typo'd domain and
      // a store that is down look identical otherwise.
      const error =
        probe.reason === "auth"
          ? "La tienda rechazó esa clave. Revisá que tenga permisos de lectura y escritura."
          : probe.reason === "not-woocommerce"
            ? "Esa dirección responde, pero no parece una tienda WooCommerce."
            : probe.status === 404
              ? "Esa dirección responde, pero no encontramos la API de WooCommerce. ¿Está bien el dominio?"
              : probe.status >= 500
                ? "La tienda respondió con un error. Probá de nuevo en un rato."
                : "No pudimos contactar la tienda."
      return NextResponse.json({ error }, { status: 502, headers: NO_STORE })
    }

    return NextResponse.json(
      { ok: true, storeUrl, storeCurrency: probe.storeCurrency },
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
