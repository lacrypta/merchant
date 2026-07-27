import { NextResponse } from "next/server"

import { requestInvoice } from "@/lib/server/lnurl"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { mintToken, readToken } from "@/lib/server/signed-url"

/**
 * Mint a BOLT-11 from the merchant's wallet.
 *
 * POST, not GET, because a NIP-57 zap request carrying the order's line items
 * is far too big for our own query string.
 *
 * The callback URL is never supplied by the caller — only a token we minted
 * in /api/ln/resolve, whose bounds we re-check here so a client cannot ask
 * for an amount outside what the merchant's wallet declared.
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
  // The expensive one: every call is an outbound request to a third party.
  const limited = rateLimit(`ln-invoice:${clientIp(request)}`, {
    max: 10,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Demasiados pedidos. Probá de nuevo en unos segundos." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) } }
    )
  }

  let body: {
    callback?: unknown
    amountMsat?: unknown
    comment?: unknown
    zapRequest?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json(
      { error: "Cuerpo inválido." },
      { status: 400, headers: NO_STORE }
    )
  }

  const token = readToken(
    typeof body.callback === "string" ? body.callback : null,
    "cb",
    Date.now()
  )
  if (!token.ok) {
    return NextResponse.json(
      {
        error:
          token.reason === "expired"
            ? "La sesión de pago venció. Volvé a intentar."
            : "Pedido de pago inválido.",
        expired: token.reason === "expired",
      },
      { status: token.reason === "expired" ? 410 : 400, headers: NO_STORE }
    )
  }

  const amountMsat = body.amountMsat
  if (
    typeof amountMsat !== "number" ||
    !Number.isSafeInteger(amountMsat) ||
    amountMsat <= 0 ||
    // Whole satoshis only: plenty of wallets reject a sub-sat remainder.
    amountMsat % 1000 !== 0
  ) {
    return NextResponse.json(
      { error: "Importe inválido." },
      { status: 400, headers: NO_STORE }
    )
  }

  // Re-check against the bounds carried INSIDE the token, so a client cannot
  // request outside what the merchant's own wallet declared.
  if (
    (token.payload.min !== undefined && amountMsat < token.payload.min) ||
    (token.payload.max !== undefined && amountMsat > token.payload.max)
  ) {
    return NextResponse.json(
      { error: "El importe está fuera de lo que acepta el comercio." },
      { status: 400, headers: NO_STORE }
    )
  }

  const comment =
    typeof body.comment === "string" && body.comment.length <= 500
      ? body.comment
      : null
  const zapRequest =
    typeof body.zapRequest === "string" && body.zapRequest.length <= 8_000
      ? body.zapRequest
      : null

  try {
    const result = await requestInvoice(token.payload.u, {
      amountMsat,
      comment,
      zapRequest,
    })
    if (!result) {
      return NextResponse.json(
        { error: "La billetera del comercio no pudo generar la factura." },
        { status: 502, headers: NO_STORE }
      )
    }

    return NextResponse.json(
      {
        pr: result.pr,
        // Only fields, never the upstream body — so this endpoint can never
        // be used as a generic fetch-and-echo oracle.
        verify: result.verify
          ? mintToken({ u: result.verify, k: "vf" }, Date.now())
          : null,
        successAction: result.successAction,
        amountMsat,
      },
      { headers: NO_STORE }
    )
  } catch {
    return NextResponse.json(
      { error: "No se pudo contactar a la billetera del comercio." },
      { status: 502, headers: NO_STORE }
    )
  }
}
