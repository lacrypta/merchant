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
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number]
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 192 && b === 0) return true // IETF protocol assignments
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

        // Re-validate on every reconnect of a kept-alive socket.
        socket.once("connect", () => {
          const addr = socket.remoteAddress
          if (addr && isPrivateAddress(addr)) socket.destroy()
        })

        return callback(null, socket)
      })
    },
  })

  return cachedAgent
}

/** Cap on the response body we're willing to read (64 KB). */
export const MAX_RESPONSE_BYTES = 64 * 1024
