import "server-only"

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { request } from "undici"

import { looksLikeInvoice } from "@/lib/domain/bolt11"
import { readJsonBody, ssrfSafeAgent } from "@/lib/server/ssrf"

/**
 * LUD-16 / LUD-06 / LUD-21 client, server-side only.
 *
 * The hostname here comes from a merchant's kind-0 `lud16`, which is
 * arbitrary attacker-controlled input — the same threat model as the NIP-05
 * proxy, so it reuses the same rebinding-proof dispatcher.
 */

/** LUD-16 limits the local part to a-z0-9-_. */
const ADDRESS_RE = /^([a-z0-9\-_.]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i

export function parseLightningAddress(
  address: string
): { name: string; domain: string } | null {
  const m = ADDRESS_RE.exec(address.trim().toLowerCase())
  if (!m) return null
  return { name: m[1]!, domain: m[2]! }
}

export interface PayParams {
  callback: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey: string | null
  /** sha256 of the raw metadata string — used to detect an ignored zap. */
  metadataSha256: string
}

export interface InvoiceResult {
  pr: string
  /** LUD-21. Present far less often than you would hope. */
  verify: string | null
  successAction: { tag: string; message?: string; url?: string } | null
}

/** Shared fetch: one dispatcher, one timeout policy, one size cap. */
async function getJson(url: string): Promise<unknown | null> {
  const res = await request(url, {
    method: "GET",
    dispatcher: ssrfSafeAgent(),
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    // No cookies, no auth, no redirect following (undici's default) — a 302
    // to 169.254.169.254 is the classic SSRF bypass.
    headers: { accept: "application/json" },
  })

  if (res.statusCode !== 200) {
    res.body.destroy()
    return null
  }

  return readJsonBody(res.body)
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/**
 * Resolve a Lightning address to its pay parameters.
 *
 * Returns null for anything that fails the LUD-06 shape check — a merchant
 * domain that answers with an HTML error page must be indistinguishable from
 * one that is down.
 */
export async function resolvePayParams(address: string): Promise<PayParams | null> {
  const parsed = parseLightningAddress(address)
  if (!parsed) return null

  const json = await getJson(
    `https://${parsed.domain}/.well-known/lnurlp/${encodeURIComponent(parsed.name)}`
  )
  if (typeof json !== "object" || json === null) return null

  const d = json as Record<string, unknown>
  if (d.tag !== "payRequest") return null
  if (typeof d.callback !== "string" || !d.callback.startsWith("https://")) return null
  if (typeof d.metadata !== "string") return null

  const min = num(d.minSendable)
  const max = num(d.maxSendable)
  if (min === null || max === null || min <= 0 || max < min) return null

  // Deliberately NOT requiring the callback to share a host with the address.
  // Wallet of Satoshi serves user@walletofsatoshi.com with a callback on
  // livingroomofsatoshi.com; a same-host rule would break one of the most
  // used wallets in the room. The SSRF agent plus the shape guard carry it.
  try {
    new URL(d.callback)
  } catch {
    return null
  }

  const nostrPubkey =
    typeof d.nostrPubkey === "string" && /^[0-9a-f]{64}$/i.test(d.nostrPubkey)
      ? d.nostrPubkey.toLowerCase()
      : null

  return {
    callback: d.callback,
    minSendable: Math.floor(min),
    maxSendable: Math.floor(max),
    commentAllowed: num(d.commentAllowed) ?? 0,
    allowsNostr: d.allowsNostr === true && nostrPubkey !== null,
    nostrPubkey,
    metadataSha256: bytesToHex(sha256(utf8ToBytes(d.metadata))),
  }
}

/**
 * Ask the merchant's wallet for an invoice.
 *
 * We shape the request; the merchant's server only supplies the origin and
 * path. Their own query params are preserved, ours are appended.
 */
export async function requestInvoice(
  callback: string,
  {
    amountMsat,
    comment,
    zapRequest,
  }: { amountMsat: number; comment?: string | null; zapRequest?: string | null }
): Promise<InvoiceResult | null> {
  const parts = [`amount=${amountMsat}`]
  // `encodeURIComponent` emits %20 for spaces; URLSearchParams would emit `+`,
  // which more than one LNURL server decodes literally.
  if (zapRequest) parts.push(`nostr=${encodeURIComponent(zapRequest)}`)
  if (comment) parts.push(`comment=${encodeURIComponent(comment)}`)

  const url = `${callback}${callback.includes("?") ? "&" : "?"}${parts.join("&")}`
  const json = await getJson(url)
  if (typeof json !== "object" || json === null) return null

  const d = json as Record<string, unknown>
  if (d.status === "ERROR") return null
  if (typeof d.pr !== "string" || d.pr.length > 2048 || !looksLikeInvoice(d.pr)) {
    return null
  }

  // The verify URL must be same-origin as the callback. Every LUD-21
  // implementation mints it there, so this costs nothing and closes a hop an
  // attacker would otherwise get for free.
  let verify: string | null = null
  if (typeof d.verify === "string") {
    try {
      if (new URL(d.verify).origin === new URL(callback).origin) verify = d.verify
    } catch {
      verify = null
    }
  }

  return { pr: d.pr, verify, successAction: readSuccessAction(d.successAction) }
}

/** LUD-09. Only two tags pass, and a url is forced to https and never followed. */
function readSuccessAction(v: unknown): InvoiceResult["successAction"] {
  if (typeof v !== "object" || v === null) return null
  const a = v as Record<string, unknown>
  if (a.tag === "message" && typeof a.message === "string") {
    return { tag: "message", message: a.message.slice(0, 200) }
  }
  if (a.tag === "url" && typeof a.url === "string") {
    try {
      const u = new URL(a.url)
      if (u.protocol !== "https:") return null
      return {
        tag: "url",
        url: u.toString(),
        message: typeof a.message === "string" ? a.message.slice(0, 200) : undefined,
      }
    } catch {
      return null
    }
  }
  return null
}

export interface VerifyResult {
  settled: boolean
  preimage: string | null
}

/** LUD-21 settlement check. */
export async function checkVerify(url: string): Promise<VerifyResult | null> {
  const json = await getJson(url)
  if (typeof json !== "object" || json === null) return null
  const d = json as Record<string, unknown>
  if (d.status === "ERROR") return null

  const preimage =
    typeof d.preimage === "string" && /^[0-9a-f]{64}$/i.test(d.preimage)
      ? d.preimage.toLowerCase()
      : null

  return { settled: d.settled === true, preimage }
}
