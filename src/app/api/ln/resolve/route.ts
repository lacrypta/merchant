import { NextResponse } from "next/server"

import { parseLightningAddress, resolvePayParams } from "@/lib/server/lnurl"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { mintToken } from "@/lib/server/signed-url"

/**
 * Lightning address → pay parameters.
 *
 * The merchant's `lud16` domain is arbitrary attacker-controlled input, so
 * this goes out through the rebinding-proof SSRF dispatcher, and the callback
 * URL we discover comes back to the browser only as a SIGNED OPAQUE TOKEN —
 * never as a URL it could edit.
 */
export const runtime = "nodejs"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(request: Request) {
  const limited = rateLimit(`ln-resolve:${clientIp(request)}`, {
    max: 30,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Demasiados pedidos. Probá de nuevo en unos segundos." },
      {
        status: 429,
        headers: {
          ...CORS,
          "Retry-After": String(limited.retryAfter),
          "Cache-Control": "no-store",
        },
      }
    )
  }

  const addr = new URL(request.url).searchParams.get("addr")?.trim()

  // Shape check before any network call, so the SSRF guard is a second line
  // of defence rather than the first.
  if (!addr || !parseLightningAddress(addr)) {
    return NextResponse.json(
      { error: "No es una dirección Lightning válida." },
      { status: 400, headers: CORS }
    )
  }

  try {
    const params = await resolvePayParams(addr)
    if (!params) {
      return NextResponse.json(
        { error: "El comercio no tiene Lightning configurado o no responde." },
        { status: 502, headers: { ...CORS, "Cache-Control": "no-store" } }
      )
    }

    return NextResponse.json(
      {
        addr,
        min: params.minSendable,
        max: params.maxSendable,
        commentAllowed: params.commentAllowed,
        allowsNostr: params.allowsNostr,
        nostrPubkey: params.nostrPubkey,
        metadataSha256: params.metadataSha256,
        // The ORIGIN alone, never the full callback. Safe to expose — it is
        // not usable as a proxy target — and it is what lets the client pin
        // the payee, so a re-resolve that quietly points at a different host
        // can be refused instead of silently redirecting the money.
        origin: new URL(params.callback).origin,
        // The client has to size the NIP-57 zap request against the real
        // outbound URL. It cannot see that URL, so it gets the length.
        callbackLength: params.callback.length,
        callback: mintToken(
          {
            u: params.callback,
            k: "cb",
            min: params.minSendable,
            max: params.maxSendable,
          },
          Date.now()
        ),
      },
      {
        headers: {
          ...CORS,
          // Short: a merchant who just switched wallets must not keep
          // receiving at the old one. The token's own TTL is 15 minutes.
          "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        },
      }
    )
  } catch {
    // Includes SsrfBlockedError — never leak which internal address was hit.
    return NextResponse.json(
      { error: "No se pudo contactar a la billetera del comercio." },
      { status: 502, headers: { ...CORS, "Cache-Control": "no-store" } }
    )
  }
}
