import { NextResponse } from "next/server"

import { parseNip05, resolveNip05 } from "@/lib/server/nip05"

/**
 * NIP-05 resolver proxy.
 *
 * Must be server-side: arbitrary merchant domains don't send CORS headers, so
 * a browser fetch fails for most real handles. The SSRF hardening lives in
 * src/lib/server/ssrf.ts — this endpoint is the one place an attacker fully
 * controls the hostname we connect to.
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
  const address = new URL(request.url).searchParams.get("address")?.trim()

  if (!address) {
    return NextResponse.json(
      { error: "Falta el parámetro `address`." },
      { status: 400, headers: CORS }
    )
  }

  // Reject anything that isn't a well-formed NIP-05 before touching the
  // network, so the SSRF guard is a second line of defence, not the first.
  if (!parseNip05(address)) {
    return NextResponse.json(
      { error: "No es una dirección NIP-05 válida." },
      { status: 400, headers: CORS }
    )
  }

  try {
    const result = await resolveNip05(address)
    if (!result) {
      return NextResponse.json(
        { address, pubkey: null, relays: [] },
        { status: 404, headers: { ...CORS, "Cache-Control": "public, max-age=60" } }
      )
    }

    return NextResponse.json(
      { address, pubkey: result.pubkey, relays: result.relays },
      {
        headers: {
          ...CORS,
          // NIP-05 is identification, not verification: it can legitimately
          // change owner. Cache briefly, never indefinitely.
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        },
      }
    )
  } catch {
    // Includes SsrfBlockedError — never leak which internal address was hit.
    return NextResponse.json(
      { error: "No se pudo resolver." },
      { status: 400, headers: CORS }
    )
  }
}
