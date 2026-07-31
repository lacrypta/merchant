import "server-only"

import { utf8ToBytes } from "@noble/hashes/utils.js"
import { NextResponse } from "next/server"

/**
 * Transport-level bits every authenticated route repeats: CORS, the JSON
 * shapes, and the one place that knows how big a request body may be.
 *
 * Split out of coupon-api.ts once a second family of routes needed them.
 * Importing that module from /api/auth/session would have dragged in drizzle,
 * the coupon store and NIP-05 resolution to send a 400 — and a session must
 * work on a deployment with no database at all.
 *
 * coupon-api.ts and nip98.ts re-export everything here, so no route file
 * changed when it moved.
 */

/**
 * Wide-open CORS, like every other route here — the difference is that these
 * respond to `Authorization`, which is NOT a CORS-safelisted header, so a
 * cross-origin POS gets a preflight and would be refused without it named.
 */
export function cors(methods: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}

/** Authenticated state is never cacheable: the answer is per-caller. */
export function noStore(methods: string): Record<string, string> {
  return { ...cors(methods), "Cache-Control": "no-store" }
}

export function preflight(methods: string): NextResponse {
  return new NextResponse(null, { status: 204, headers: cors(methods) })
}

export function fail(
  message: string,
  status: number,
  methods: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status, headers: noStore(methods) })
}

export function ok(payload: unknown, methods: string, status = 200): NextResponse {
  return NextResponse.json(payload, { status, headers: noStore(methods) })
}

// ───────────────────────────────────────────────────────────────────────────
// Bodies
// ───────────────────────────────────────────────────────────────────────────

/** Bodies here are a handful of fields; anything larger is not ours. */
export const MAX_BODY_BYTES = 16_384
/** A signed event base64s to ~700 bytes. 8 KB is generous and bounded. */
export const MAX_AUTH_HEADER_BYTES = 8_192

export type BoundedBody =
  | { ok: true; rawBody: string }
  | { ok: false; status: 401 | 413; error: string; reason: "malformed" | "too-large" }

/**
 * Read the body once, refusing anything oversized.
 *
 * A Request body can be consumed exactly once, so whoever authenticates has to
 * be the one who reads it — NIP-98 hashes these bytes, and both schemes hand
 * the string back for the route to parse. Calling request.json() downstream
 * gets you an empty body and a very confusing hour.
 *
 * The size cap is a security control, which is the whole reason this lives in
 * one function: two copies is how one of them stays at 16 KB while the other
 * quietly grows.
 */
export async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const tooLarge = {
    ok: false,
    status: 413,
    error: "El cuerpo es demasiado grande.",
    reason: "too-large",
  } as const

  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge

  let rawBody = ""
  try {
    rawBody = await request.text()
  } catch {
    return {
      ok: false,
      status: 401,
      error: "No pudimos leer el cuerpo del pedido.",
      reason: "malformed",
    }
  }

  // content-length can lie or be absent (chunked); this is the real check.
  if (utf8ToBytes(rawBody).length > MAX_BODY_BYTES) return tooLarge

  return { ok: true, rawBody }
}
