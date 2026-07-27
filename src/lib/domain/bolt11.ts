import { bech32 } from "@scure/base"

/**
 * A minimal BOLT-11 reader. Decode only — we never build invoices.
 *
 * Four fields justify the whole file, and each one is load-bearing:
 *
 *  - `amountMsat` — an invoice whose amount doesn't match what we asked for,
 *    or that carries no amount at all, must be REFUSED. An amountless invoice
 *    lets the payer settle a 12.000-peso order for one satoshi.
 *  - `expiresAt` — the countdown. Without it we'd have to assume the BOLT-11
 *    default of one hour and would be wrong on every wallet that issues
 *    ten-minute invoices.
 *  - `paymentHash` — joins a NIP-57 receipt (and a pasted preimage) back to
 *    the specific invoice it settles.
 *  - `descriptionHash` — tells us whether the provider honoured our `nostr`
 *    parameter or quietly fell back to a plain LNURL pay, which is the
 *    difference between waiting for a zap receipt and waiting forever.
 */

/** Tagged-field types, as 5-bit values. See BOLT-11 "Tagged Fields". */
const TAG_PAYMENT_HASH = 1
const TAG_DESCRIPTION_HASH = 23
const TAG_EXPIRY = 6

/** BOLT-11's default expiry when no `x` field is present. */
export const DEFAULT_EXPIRY_SECONDS = 3600

/** The signature is a fixed 65 bytes = 104 five-bit words at the very end. */
const SIGNATURE_WORDS = 104
/** The invoice timestamp is the first 7 words (35 bits). */
const TIMESTAMP_WORDS = 7

export interface DecodedInvoice {
  /** Human-readable prefix, e.g. `lnbc` / `lntb` / `lnbcrt`. */
  prefix: string
  /** null when the invoice carries no amount — always a rejection for us. */
  amountMsat: number | null
  /** Unix SECONDS, from the invoice itself. */
  timestamp: number
  expirySeconds: number
  /** `timestamp + expirySeconds`, in unix seconds. */
  expiresAt: number
  paymentHash: string | null
  descriptionHash: string | null
}

/**
 * Multiplier → msat per unit. One BTC is 1e11 msat.
 *
 * `p` (pico-BTC) is 0.1 msat, so it is the one multiplier that can express a
 * sub-msat amount; BOLT-11 requires those to be a multiple of 10 and we
 * reject anything else rather than rounding someone's money.
 */
const MULTIPLIER_MSAT: Record<string, bigint> = {
  m: 100_000_000n, // milli
  u: 100_000n, // micro
  n: 100n, // nano
  p: 0n, // pico — handled separately, see below
}

const PREFIX_RE = /^(ln(?:bcrt|bc|tbs|tb|sb))(\d*)([munp]?)$/

function parseHrp(hrp: string): { prefix: string; amountMsat: number | null } | null {
  const m = PREFIX_RE.exec(hrp)
  if (!m) return null

  const [, prefix, digits, multiplier] = m as unknown as [
    string,
    string,
    string,
    string,
  ]
  if (!digits) return { prefix, amountMsat: null }

  const value = BigInt(digits)

  let msat: bigint
  if (multiplier === "p") {
    // Pico-BTC is 0.1 msat. A non-multiple of 10 would be a fractional msat,
    // which BOLT-11 forbids — treat it as malformed, never as rounded.
    if (value % 10n !== 0n) return null
    msat = value / 10n
  } else if (multiplier) {
    msat = value * MULTIPLIER_MSAT[multiplier]!
  } else {
    msat = value * 100_000_000_000n // whole BTC
  }

  // Nothing legitimate reaches this, but a hostile hrp can claim 10^30 msat
  // and silently lose precision the moment it becomes a Number.
  if (msat > BigInt(Number.MAX_SAFE_INTEGER)) return null

  return { prefix, amountMsat: Number(msat) }
}

/** Big-endian decode of 5-bit words into a number. Used for small fields. */
function wordsToNumber(words: readonly number[]): number {
  let n = 0
  for (const w of words) n = n * 32 + w
  return n
}

/** Big-endian 5-bit → 8-bit repacking, dropping the trailing partial byte. */
function wordsToHex(words: readonly number[]): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const w of words) {
    value = (value << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out += ((value >> bits) & 0xff).toString(16).padStart(2, "0")
    }
  }
  return out
}

/**
 * Returns null for anything malformed rather than throwing: every invoice we
 * decode came from a merchant-controlled server, so a bad one is an expected
 * input, not an exception.
 */
export function decodeInvoice(pr: string): DecodedInvoice | null {
  const raw = pr.trim().toLowerCase()
  if (!raw.startsWith("ln")) return null

  // `false` disables bech32's 90-character limit, which BOLT-11 does not
  // observe — real invoices run several hundred characters.
  const decoded = bech32.decodeUnsafe(raw, false)
  if (!decoded) return null

  const { prefix: hrp, words } = decoded
  const hrpParsed = parseHrp(hrp)
  if (!hrpParsed) return null

  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) return null
  const timestamp = wordsToNumber(words.slice(0, TIMESTAMP_WORDS))
  const fields = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS)

  let paymentHash: string | null = null
  let descriptionHash: string | null = null
  let expirySeconds = DEFAULT_EXPIRY_SECONDS

  let i = 0
  while (i + 3 <= fields.length) {
    const type = fields[i]!
    // Length is two words, big-endian, in WORDS not bytes.
    const length = fields[i + 1]! * 32 + fields[i + 2]!
    const start = i + 3
    const end = start + length
    if (end > fields.length) return null // truncated field ⇒ malformed

    const data = fields.slice(start, end)
    switch (type) {
      case TAG_PAYMENT_HASH:
        // 52 words = 256 bits + 4 padding. Ignore any other length: BOLT-11
        // says unknown-length versions of known fields must be skipped.
        if (length === 52) paymentHash ??= wordsToHex(data)
        break
      case TAG_DESCRIPTION_HASH:
        if (length === 52) descriptionHash ??= wordsToHex(data)
        break
      case TAG_EXPIRY:
        expirySeconds = wordsToNumber(data)
        break
      default:
        break // routing hints, features, fallbacks — none of our business
    }

    i = end
  }

  return {
    prefix: hrpParsed.prefix,
    amountMsat: hrpParsed.amountMsat,
    timestamp,
    expirySeconds,
    expiresAt: timestamp + expirySeconds,
    paymentHash,
    descriptionHash,
  }
}

/** Cheap shape check for anything claiming to be an invoice. */
export function looksLikeInvoice(pr: string): boolean {
  return /^ln(bcrt|bc|tbs|tb|sb)[0-9a-z]{100,}$/i.test(pr.trim())
}
