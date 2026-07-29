import { describe, expect, it } from "vitest"

import { isPrivateAddress } from "./ssrf"

describe("isPrivateAddress — blocks", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    // The one that matters most: cloud instance metadata.
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    // IETF protocol assignments and TEST-NET-1.
    "192.0.0.8",
    "192.0.2.1",
    // CGNAT.
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    // IPv6.
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::1",
    // IPv4-mapped IPv6 must not be a way around the IPv4 rules.
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "[::1]",
    // Unparseable fails closed.
    "not-an-ip",
    "",
  ]

  it.each(blocked)("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })
})

describe("isPrivateAddress — allows", () => {
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    // Automattic / WordPress.com. The whole of 192.0.0.0/16 used to be
    // blocked, which made every WordPress.com-hosted store unreachable.
    "192.0.66.5",
    "192.0.78.12",
    // Neighbours of the private ranges, just outside them.
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "11.0.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "223.255.255.255",
    "2606:4700::1111",
  ]

  it.each(allowed)("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})
