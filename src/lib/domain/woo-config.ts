import { KINDS } from "@/lib/domain/kinds"
import type { EventBody } from "@/lib/domain/product"
import { nextCreatedAt } from "@/lib/nostr/created-at"
import { coordinate, tagValue } from "@/lib/nostr/tags"
import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * The merchant's WooCommerce connection, stored as NIP-78 app data.
 *
 * Kind 30078 is addressable, so the connection updates in place instead of
 * accumulating a trail of superseded credentials on every relay.
 *
 * The content is ALWAYS NIP-44 ciphertext. `consumer_secret` is a write
 * credential over the merchant's live store — anyone who reads it can create
 * orders, edit products and read customer data. Publishing that in the clear
 * on public relays would be handing it out.
 */

/** Our `d` tag. Kind 30078 is shared by every app; the `d` is the whole fence. */
export const WOO_CONFIG_D = "lacrypta.merchant/woocommerce"

export type WooScope = "read" | "write" | "read_write"

export interface WooConnection {
  v: 1
  /** Origin only, no trailing slash, no path. */
  storeUrl: string
  consumerKey: string
  consumerSecret: string
  keyPermissions: WooScope
  /** ISO-4217 code from the store's own settings. Orders must use it. */
  storeCurrency: string
  /** Unix seconds. */
  connectedAt: number
}

export type ParsedConnection =
  | { ok: true; value: WooConnection }
  | { ok: false; reason: string }

/**
 * Normalise a store URL to a bare https origin.
 *
 * Returns null for anything that is not plain https — the API routes refuse
 * non-https anyway (credentials would cross the wire in the clear), so
 * rejecting here keeps the bad value out of the stored config entirely.
 */
export function normalizeStoreUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withScheme)
    if (url.protocol !== "https:") return null
    if (!url.hostname.includes(".")) return null
    return url.origin
  } catch {
    return null
  }
}

const SCOPES: readonly string[] = ["read", "write", "read_write"]

/**
 * Parse decrypted config.
 *
 * Any version other than 1 is DISCARDED, never migrated — same rule as the
 * cart. A half-understood config here means talking to a store with fields we
 * guessed at.
 */
export function parseWooConnection(plaintext: string): ParsedConnection {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return { ok: false, reason: "no es JSON" }
  }

  if (!raw || typeof raw !== "object") return { ok: false, reason: "no es un objeto" }
  const c = raw as Partial<WooConnection>

  if (c.v !== 1) return { ok: false, reason: `versión desconocida: ${String(c.v)}` }

  const storeUrl = typeof c.storeUrl === "string" ? normalizeStoreUrl(c.storeUrl) : null
  if (!storeUrl) return { ok: false, reason: "storeUrl inválido" }

  if (typeof c.consumerKey !== "string" || !c.consumerKey) {
    return { ok: false, reason: "falta consumerKey" }
  }
  if (typeof c.consumerSecret !== "string" || !c.consumerSecret) {
    return { ok: false, reason: "falta consumerSecret" }
  }
  if (typeof c.storeCurrency !== "string" || !/^[A-Z]{3}$/.test(c.storeCurrency)) {
    return { ok: false, reason: "storeCurrency inválida" }
  }

  return {
    ok: true,
    value: {
      v: 1,
      storeUrl,
      consumerKey: c.consumerKey,
      consumerSecret: c.consumerSecret,
      keyPermissions: SCOPES.includes(c.keyPermissions ?? "")
        ? (c.keyPermissions as WooScope)
        : "read_write",
      storeCurrency: c.storeCurrency,
      connectedAt:
        typeof c.connectedAt === "number" && Number.isFinite(c.connectedAt)
          ? c.connectedAt
          : 0,
    },
  }
}

export function serializeWooConnection(c: WooConnection): string {
  return JSON.stringify(c)
}

/**
 * Is this 30078 one of ours, and safe to replace?
 *
 * Kind 30078 is shared by design — Coracle, Flotilla and others all publish
 * their own. The `d` tag is the only separation, so the rule from
 * `isOurCollection()` applies verbatim: only ever publish over a `d` we
 * generated, from the author we expect. Content is NOT inspected here, because
 * we cannot read it without the signer.
 */
export function isOurWooConfig(e: SignedEvent, pubkey: string, d: string): boolean {
  return (
    e.kind === KINDS.APP_DATA && e.pubkey === pubkey && tagValue(e, "d") === d
  )
}

/**
 * The timestamp-free half. Same split as `productEventBody` — see the comment
 * there for why the diff must never go through `nextCreatedAt()`.
 */
export function appDataEventBody(d: string, ciphertext: string): EventBody {
  return {
    kind: KINDS.APP_DATA,
    content: ciphertext,
    tags: [
      ["d", d],
      ["client", "merchant-manager"],
    ],
  }
}

/**
 * @param ciphertext MUST already be NIP-44 sealed. This function cannot check
 *   that — it has no signer — so the one call path that builds it is the one
 *   that encrypts.
 */
export function buildAppDataEvent(
  d: string,
  ciphertext: string,
  pubkey: string,
  previousCreatedAt?: number
): EventTemplate {
  return {
    ...appDataEventBody(d, ciphertext),
    created_at: nextCreatedAt(coordinate(KINDS.APP_DATA, pubkey, d), previousCreatedAt),
  }
}
