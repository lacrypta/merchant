import { NextResponse } from "next/server"

import { checkVerify } from "@/lib/server/lnurl"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { readToken } from "@/lib/server/signed-url"

/**
 * LUD-21 settlement poll.
 *
 * Its own rate-limit bucket, and a generous one: a ten-minute checkout at the
 * documented cadence is ~240 legitimate polls. Sharing the invoice route's
 * bucket of 10/min would lock out a real customer halfway through paying.
 */
export const runtime = "nodejs"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const NO_STORE = { ...CORS, "Cache-Control": "no-store" }

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(request: Request) {
  const limited = rateLimit(`ln-verify:${clientIp(request)}`, {
    max: 90,
    windowMs: 60_000,
  })
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Demasiadas consultas." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) } }
    )
  }

  const token = readToken(
    new URL(request.url).searchParams.get("token"),
    "vf",
    Date.now()
  )
  if (!token.ok) {
    return NextResponse.json(
      { error: "Consulta inválida.", expired: token.reason === "expired" },
      { status: token.reason === "expired" ? 410 : 400, headers: NO_STORE }
    )
  }

  try {
    const result = await checkVerify(token.payload.u)
    if (!result) {
      return NextResponse.json(
        { error: "La billetera no respondió." },
        { status: 502, headers: NO_STORE }
      )
    }
    // Two fields and nothing else.
    return NextResponse.json(
      { settled: result.settled, preimage: result.preimage },
      { headers: NO_STORE }
    )
  } catch {
    return NextResponse.json(
      { error: "La billetera no respondió." },
      { status: 502, headers: NO_STORE }
    )
  }
}
