"use client"

import * as React from "react"

import { queryEvents } from "@/lib/nostr/backend"
import type { PublishReport, SignedEvent } from "@/lib/nostr/types"

/**
 * Which relays actually hold a given event.
 *
 * The catalog's own read cannot answer this: it merges every relay's results
 * into one list, so "we have it" and "one of five has it" look identical. For
 * the discovery announcement that difference is the whole question — a POS asks
 * the merchant's relays, and a relay that never got the event is a till that
 * cannot find their coupons.
 *
 * So each relay is asked separately, by event id. One request per relay is
 * cheap (an id filter is the most selective there is) and it is the only way to
 * get an answer per relay out of a pool API that merges.
 */

export type RelayCheckState =
  | "checking"
  | "found"
  /** Asked, and it does not have this event. */
  | "missing"
  /** Was missing, and we just sent it there. */
  | "republished"
  /** Was missing, and the re-send did not land either. */
  | "failed"

export interface RelayCheck {
  relay: string
  state: RelayCheckState
  /** Why the re-send failed, when the relay told us. */
  reason?: string
}

export interface RelayCheckResult {
  checks: RelayCheck[]
  /** True while at least one relay has not answered yet. */
  checking: boolean
  /** Relays that answered "no". The set to re-publish to. */
  missing: string[]
  /** Fold a publish report back in, so the rows show what happened. */
  applyReport: (report: PublishReport | null) => void
  /** Ask the relays again. */
  recheck: () => void
}

const QUERY_TIMEOUT_MS = 5_000

type Answer = { state: Exclude<RelayCheckState, "checking">; reason?: string }

export function useRelayCheck(
  event: SignedEvent | null,
  relays: readonly string[]
): RelayCheckResult {
  /**
   * Answers keyed by round, event and relay.
   *
   * Keyed rather than cleared, so a new event or a re-check simply stops
   * matching the old entries — which means the effect never has to seed state
   * synchronously, and a late reply from a previous round cannot overwrite the
   * current one.
   */
  const [answers, setAnswers] = React.useState<Record<string, Answer>>({})
  const [round, setRound] = React.useState(0)

  // A stable key: the catalog hands us a new array identity on every refetch,
  // and restarting the queries for that would be pointless traffic.
  const relayKey = relays.join(",")
  const eventId = event?.id ?? null
  const keyFor = React.useCallback(
    (relay: string) => `${round}|${eventId}|${relay}`,
    [round, eventId]
  )

  React.useEffect(() => {
    if (!eventId || !relayKey) return
    let cancelled = false

    for (const relay of relayKey.split(",")) {
      const key = `${round}|${eventId}|${relay}`
      void queryEvents([{ ids: [eventId] }], [relay], {
        timeoutMs: QUERY_TIMEOUT_MS,
        label: "Anuncio de cupones",
      })
        .then((found) => {
          if (cancelled) return
          const state = found.some((e) => e.id === eventId) ? "found" : "missing"
          setAnswers((prev) => ({ ...prev, [key]: { state } }))
        })
        .catch(() => {
          if (cancelled) return
          // A relay we cannot reach is not the same as a relay that lacks the
          // event, but for the merchant the consequence is identical: a POS
          // asking it comes back empty. Treat it as missing and let the re-send
          // try its luck.
          setAnswers((prev) => ({ ...prev, [key]: { state: "missing" } }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [eventId, relayKey, round])

  const checks = React.useMemo<RelayCheck[]>(() => {
    if (!eventId || !relayKey) return []
    return relayKey.split(",").map((relay) => {
      const answer = answers[`${round}|${eventId}|${relay}`]
      return answer
        ? { relay, state: answer.state, reason: answer.reason }
        : { relay, state: "checking" as const }
    })
  }, [answers, eventId, relayKey, round])

  const applyReport = React.useCallback(
    (report: PublishReport | null) => {
      if (!report) return
      setAnswers((prev) => {
        const next = { ...prev }
        for (const relay of report.ok) {
          next[keyFor(relay)] = { state: "republished" }
        }
        for (const failure of report.failed) {
          next[keyFor(failure.relay)] = { state: "failed", reason: failure.reason }
        }
        return next
      })
    },
    [keyFor]
  )

  return {
    checks,
    checking: checks.some((c) => c.state === "checking"),
    missing: checks.filter((c) => c.state === "missing").map((c) => c.relay),
    applyReport,
    recheck: React.useCallback(() => setRound((n) => n + 1), []),
  }
}
