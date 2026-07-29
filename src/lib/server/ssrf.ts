import "server-only"

import net from "node:net"
import { Agent, buildConnector } from "undici"

/**
 * SSRF hardening for the NIP-05 proxy — the one endpoint where an attacker
 * fully controls the hostname.
 *
 * A pre-flight `dns.lookup` check is NOT sufficient on its own: DNS rebinding
 * lets a hostname resolve to a public IP during the check and a private one
 * during the actual connection. The real defence is validating
 * `socket.remoteAddress` AFTER the TCP connection is established, which is
 * what the custom connector below does.
 */

/** Strip the IPv4-mapped IPv6 prefix: ::ffff:10.0.0.1 -> 10.0.0.1 */
function unmapIPv4(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  return m ? m[1]! : ip
}

export function isPrivateAddress(rawIp: string): boolean {
  const ip = unmapIPv4(rawIp.replace(/^\[|\]$/g, ""))
  const version = net.isIP(ip)
  if (version === 0) return true // unparseable -> refuse

  if (version === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number]
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    /**
     * Only two /24s inside 192.0.0.0/16 are reserved: 192.0.0.0/24 (IETF
     * protocol assignments) and 192.0.2.0/24 (TEST-NET-1). The rest is
     * ordinary public space — 192.0.66.0/24 is Automattic's, which is where a
     * WordPress.com-hosted WooCommerce store answers from. Blocking the whole
     * /16 made every one of those unreachable.
     */
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast, reserved, broadcast
    return false
  }

  const lower = ip.toLowerCase()
  if (lower === "::" || lower === "::1") return true // unspecified / loopback
  if (/^f[cd]/.test(lower)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true // fe80::/10 link-local
  if (lower.startsWith("ff")) return true // multicast
  if (lower.startsWith("2001:db8")) return true // documentation
  if (lower.startsWith("64:ff9b")) return true // NAT64
  return false
}

export class SsrfBlockedError extends Error {
  constructor(readonly address: string) {
    super(`Blocked request to non-public address: ${address}`)
    this.name = "SsrfBlockedError"
  }
}

/**
 * An undici Agent that destroys any connection landing on a non-public IP.
 *
 * The check runs on the CONNECTED socket, so it sees the address actually
 * used rather than one DNS returned earlier — this is what makes it
 * rebinding-proof.
 */
let cachedAgent: Agent | undefined

export function ssrfSafeAgent(): Agent {
  if (cachedAgent) return cachedAgent

  const baseConnector = buildConnector({ timeout: 5_000 })

  cachedAgent = new Agent({
    connectTimeout: 5_000,
    connect(opts, callback) {
      baseConnector(opts, (err, socket) => {
        if (err) return callback(err, null)

        const remote = socket?.remoteAddress
        if (!remote || isPrivateAddress(remote)) {
          socket?.destroy()
          return callback(new SsrfBlockedError(remote ?? "unknown"), null)
        }

        /**
         * A socket with no 'error' listener escalates to an
         * uncaughtException and takes the server down. That is not
         * hypothetical: a plain ETIMEDOUT reaching an unhandled socket
         * crashed the dev server and blanked every page.
         *
         * undici handles the failure through its own pipeline; this listener
         * exists purely so Node never sees an unhandled 'error' event.
         */
        socket.on("error", () => {
          /* handled by undici; swallow so Node doesn't escalate it */
        })

        return callback(null, socket)
      })
    },
  })

  return cachedAgent
}

/** Default cap on the response body we're willing to read (64 KB). */
export const MAX_RESPONSE_BYTES = 64 * 1024

/** Minimal shape of an undici response body. Keeps this file free of route types. */
interface ReadableBody extends AsyncIterable<unknown> {
  destroy(): void
}

/**
 * Read a capped JSON body, or null.
 *
 * Every outbound call in this app talks to a host somebody else controls, so
 * "read until the stream ends" is a denial-of-service waiting to happen: a
 * hostile server can stream forever and pin a Node process. The cap has to be
 * enforced WHILE reading, not after — checking `content-length` proves nothing
 * because the header is the sender's claim.
 *
 * Returns null on overflow, on invalid JSON, and on a non-object payload, so
 * a host answering an HTML error page is indistinguishable from one that is
 * down. Callers get one failure mode instead of three.
 */
export async function readJsonBody(
  body: ReadableBody,
  maxBytes: number = MAX_RESPONSE_BYTES
): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []

  try {
    for await (const chunk of body) {
      const buf = Buffer.from(chunk as Uint8Array)
      size += buf.length
      if (size > maxBytes) {
        body.destroy()
        return null
      }
      chunks.push(buf)
    }
  } catch {
    // A truncated or reset stream is just an unreachable host.
    body.destroy()
    return null
  }

  try {
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return typeof json === "object" && json !== null ? json : null
  } catch {
    return null
  }
}
