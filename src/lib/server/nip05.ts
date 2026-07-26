import "server-only"

import { request } from "undici"

import { MAX_RESPONSE_BYTES, ssrfSafeAgent } from "@/lib/server/ssrf"

/**
 * NIP-05 resolution, server-side.
 *
 * Must be proxied rather than fetched from the browser: arbitrary merchant
 * domains won't send CORS headers, so a client-side fetch fails for most
 * real handles.
 *
 * NIP-05 is IDENTIFICATION, NOT VERIFICATION. Always store the pubkey as the
 * primary key and treat the handle as a display string — if bob@bob.com later
 * resolves to a different pubkey, you keep the original pubkey and stop
 * showing the identifier.
 */

/** NIP-05 restricts the local part to a-z0-9-_. (and `_` means the bare domain). */
const NIP05_RE = /^(?:([a-z0-9\-_.]+)@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i

export interface Nip05Result {
  pubkey: string
  /** NIP-05's optional relay hints — a free outbox hint worth using. */
  relays: string[]
}

export function parseNip05(address: string): { name: string; domain: string } | null {
  const m = NIP05_RE.exec(address.trim().toLowerCase())
  if (!m) return null
  return { name: m[1] ?? "_", domain: m[2]! }
}

export async function resolveNip05(address: string): Promise<Nip05Result | null> {
  const parsed = parseNip05(address)
  if (!parsed) return null

  const { name, domain } = parsed
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`

  // undici's `request` does NOT follow redirects unless the redirect
  // interceptor is opted into, which is exactly what we want here: a 302 to
  // 169.254.169.254 is the classic SSRF bypass.
  const res = await request(url, {
    method: "GET",
    dispatcher: ssrfSafeAgent(),
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    headers: { accept: "application/json" },
  })

  // Treat any non-200 (including a 3xx we deliberately did not follow) as
  // unresolvable rather than chasing it.
  if (res.statusCode !== 200) {
    res.body.destroy()
    return null
  }

  // Cap the body: a hostile domain can otherwise stream forever.
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > MAX_RESPONSE_BYTES) {
      res.body.destroy()
      return null
    }
    chunks.push(buf)
  }

  let json: unknown
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return null
  }

  if (typeof json !== "object" || json === null) return null
  const names = (json as { names?: Record<string, string> }).names
  const pubkey = names?.[name]
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey)) return null

  const relayMap = (json as { relays?: Record<string, string[]> }).relays
  const relays = (relayMap?.[pubkey] ?? []).filter(
    (r) => typeof r === "string" && r.startsWith("wss://")
  )

  return { pubkey: pubkey.toLowerCase(), relays }
}
