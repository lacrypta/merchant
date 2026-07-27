import "server-only"

/**
 * A fixed-window per-IP limiter for the LNURL proxy routes.
 *
 * WHAT THIS IS NOT: a quota, or a security boundary. `x-forwarded-for` is
 * trivially spoofable unless a trusted proxy is rewriting it, and the map
 * lives in one process — it dies on a cold start and is not shared across
 * instances. What it buys is that a single careless or malicious client
 * cannot trivially turn our server into a firehose of outbound requests
 * toward a merchant's wallet host. It raises cost; it does not enforce.
 *
 * Needed here and not on /api/rates because these routes perform outbound I/O
 * toward a host the caller indirectly chooses, and because one legitimate
 * checkout generates hundreds of polls.
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** Sweep lazily rather than on a timer; a timer would keep the process warm. */
const SWEEP_THRESHOLD = 5_000

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key)
  }
}

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the window resets. Suitable for a Retry-After header. */
  retryAfter: number
}

export function rateLimit(
  key: string,
  { max, windowMs }: { max: number; windowMs: number }
): RateLimitResult {
  const now = Date.now()
  if (buckets.size > SWEEP_THRESHOLD) sweep(now)

  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfter: 0 }
  }

  existing.count += 1
  if (existing.count > max) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) }
  }
  return { ok: true, retryAfter: 0 }
}

/**
 * Best-effort client identity.
 *
 * The FIRST x-forwarded-for entry is the original client when a trusted proxy
 * appends; behind nothing, it is whatever the caller claimed. See the caveat
 * at the top of this file.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  return request.headers.get("x-real-ip")?.trim() || "anon"
}
