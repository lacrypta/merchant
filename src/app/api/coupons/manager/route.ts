import { NextResponse } from "next/server"

import { cors, preflight } from "@/lib/server/coupon-api"
import { getCouponManager } from "@/lib/server/coupon-manager"

/**
 * Who signs the coupons this deployment issues.
 *
 * Public and unauthenticated: it returns a PUBLIC key, and both callers need it
 * before they have anything else. The management page needs it to build the
 * merchant's discovery event, and a POS can use it to sanity-check that the
 * pubkey in that event still matches the service it is talking to.
 */
export const runtime = "nodejs"

const METHODS = "GET"

export async function OPTIONS() {
  return preflight(METHODS)
}

export async function GET() {
  const manager = getCouponManager()
  if (!manager) {
    return NextResponse.json(
      { error: "Los cupones no están habilitados en este servidor." },
      { status: 503, headers: { ...cors(METHODS), "Cache-Control": "no-store" } }
    )
  }

  return NextResponse.json(
    { pubkey: manager.pubkey, npub: manager.npub },
    {
      headers: {
        ...cors(METHODS),
        // The key is stable for the life of the deployment; a short TTL is only
        // so that setting the env var for the first time shows up promptly.
        "Cache-Control": "public, max-age=300",
      },
    }
  )
}
