import { NextResponse } from "next/server"

import { getRates } from "@/lib/server/yadio"

/**
 * BTC price feed, normalised to "what one satoshi is worth".
 *
 * Deliberately takes no parameters: the response is identical for everyone,
 * so it is trivially cacheable by any CDN in front of us and there is nothing
 * for a caller to aim at. That is also why it needs no rate limit, unlike
 * /api/ln/*.
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

export async function GET() {
  try {
    const snapshot = await getRates()

    return NextResponse.json(snapshot, {
      headers: {
        ...CORS,
        // A stale snapshot gets a much shorter TTL so we retry the oracle
        // soon, but still serves rather than failing.
        "Cache-Control": snapshot.stale
          ? "public, max-age=15, stale-while-revalidate=600"
          : "public, max-age=60, stale-while-revalidate=600",
      },
    })
  } catch {
    // Only reachable when the oracle is down AND we have no last-good value —
    // in practice, the first request after a cold start with no network.
    return NextResponse.json(
      { error: "No pudimos obtener la cotización." },
      { status: 503, headers: { ...CORS, "Cache-Control": "no-store" } }
    )
  }
}
