"use client"

import * as React from "react"

import { setRelayLog, type RelayLogEntry } from "@/lib/nostr/relay-log"

/**
 * Hand a server-side relay report to the client log.
 *
 * The storefront reads relays during the RSC render, so the browser never
 * sees those connections — the report has to travel as data. Rendering this
 * with the page's stats is what makes the navbar pill contextual: it always
 * describes the page you are on, not whatever this tab happened to fetch
 * earlier.
 */
export function RelayLogSeed({
  stats,
}: {
  stats: Omit<RelayLogEntry, "origin" | "at">[]
}) {
  // Serialised, so the effect re-runs on a real change and not on identity.
  const key = React.useMemo(
    () => stats.map((s) => `${s.relay}|${s.label}|${s.events}|${s.status}`).join(","),
    [stats]
  )

  React.useEffect(() => {
    setRelayLog(stats.map((s) => ({ ...s, origin: "server" as const })))
    // `stats` is a fresh array each render; `key` is its actual content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return null
}
