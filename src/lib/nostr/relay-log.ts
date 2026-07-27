"use client"

import * as React from "react"

/**
 * What the relays did for the page you are looking at.
 *
 * Deliberately CONTEXTUAL and not cumulative: navigating replaces the log
 * rather than appending to it, so the panel always answers "where did THIS
 * page's data come from" instead of turning into a session-long console.
 *
 * A module-level store rather than context because both halves feed it — the
 * storefront's reads happen on the SERVER and arrive as a serialised report,
 * while the dashboard's happen in this tab. One sink, two sources.
 */
export interface RelayLogEntry {
  /** Which read — "Catálogo", "Perfil", … */
  label: string
  relay: string
  events: number
  bytes: number
  ms: number
  /** "cut" = still going when we stopped waiting; NOT a failure. */
  status: "ok" | "empty" | "cut" | "timeout"
  /** Where the read ran. The storefront's are server-side. */
  origin: "server" | "client"
  at: number
}

let entries: RelayLogEntry[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** Replace the log — call on entering a page. */
export function setRelayLog(next: Omit<RelayLogEntry, "at">[]): void {
  const now = Date.now()
  const mapped = next.map((e) => ({ ...e, at: now }))
  // Reference equality is what useSyncExternalStore compares, so bail out when
  // nothing actually changed or a re-render would loop.
  if (
    mapped.length === entries.length &&
    mapped.every(
      (e, i) =>
        e.relay === entries[i]!.relay &&
        e.label === entries[i]!.label &&
        e.events === entries[i]!.events &&
        e.status === entries[i]!.status
    )
  ) {
    return
  }
  entries = mapped
  emit()
}

/** Append one read — for client-side queries that happen after first paint. */
export function addRelayLog(entry: Omit<RelayLogEntry, "at">): void {
  entries = [...entries, { ...entry, at: Date.now() }]
  emit()
}

export function clearRelayLog(): void {
  if (entries.length === 0) return
  entries = []
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const EMPTY: RelayLogEntry[] = []

export function useRelayLog(): RelayLogEntry[] {
  return React.useSyncExternalStore(
    subscribe,
    () => entries,
    // The server has no log; returning a stable empty array keeps the first
    // client paint identical to the server's.
    () => EMPTY
  )
}

export interface RelaySummary {
  /** Relays that answered at all — the number in the navbar pill. */
  connected: number
  total: number
  events: number
  bytes: number
}

/**
 * @param isEnabled Relays this browser is still reading from. A relay switched
 *   off is left out of `connected`/`total` — the pill answers "how many relays
 *   am I using", and counting one you deliberately turned off makes the toggle
 *   look broken. Its `events`/`bytes` DO stay counted: that data is on screen
 *   right now, and un-counting it would misreport where the page came from.
 */
export function summarise(
  log: readonly RelayLogEntry[],
  isEnabled: (relay: string) => boolean = () => true
): RelaySummary {
  const relays = new Map<string, boolean>()
  let events = 0
  let bytes = 0
  for (const e of log) {
    // Connected means it actually spoke to us. A read we cut short after
    // quorum proves nothing either way, so it does not count — but it is not
    // reported as a failure either (see the panel).
    if (isEnabled(e.relay)) {
      relays.set(
        e.relay,
        (relays.get(e.relay) ?? false) || e.status === "ok" || e.status === "empty"
      )
    }
    events += e.events
    bytes += e.bytes
  }
  return {
    connected: [...relays.values()].filter(Boolean).length,
    total: relays.size,
    events,
    bytes,
  }
}
