"use client"

import * as React from "react"

import { useReducedMotion } from "@/hooks/use-reduced-motion"

/**
 * Keep removed items on screen long enough to animate them out.
 *
 * React unmounts the moment an item leaves the array, so there is nothing left
 * to transition. This holds departed items in a local list, flagged
 * `leaving`, until their exit transition has had time to run — the minimum
 * machinery for exit animations without pulling in an animation library for
 * one list.
 *
 * Enter animations need none of this: `@starting-style` handles them in pure
 * CSS. Only leaving is hard.
 */
export interface PresenceItem<T> {
  key: string
  item: T
  /** True while the item is on its way out — drive the exit classes off this. */
  leaving: boolean
}

export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  exitMs = 220
): PresenceItem<T>[] {
  const reduced = useReducedMotion()
  const [rendered, setRendered] = React.useState<PresenceItem<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, leaving: false }))
  )

  // Timers keyed by item, so removing two things in quick succession does not
  // have the second removal cancel the first one's exit.
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())

  React.useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t)
      timers.current.clear()
    },
    []
  )

  React.useEffect(() => {
    const liveKeys = new Set(items.map(keyOf))

    setRendered((prev) => {
      const next: PresenceItem<T>[] = items.map((item) => ({
        key: keyOf(item),
        item,
        leaving: false,
      }))

      if (reduced) return next

      // Anything that was on screen and is not in the incoming list gets held
      // in place, at its old index, so the list does not jump before it fades.
      for (const [index, entry] of prev.entries()) {
        if (liveKeys.has(entry.key)) continue
        if (!timers.current.has(entry.key)) {
          timers.current.set(
            entry.key,
            setTimeout(() => {
              timers.current.delete(entry.key)
              setRendered((cur) => cur.filter((e) => e.key !== entry.key))
            }, exitMs)
          )
        }
        next.splice(Math.min(index, next.length), 0, { ...entry, leaving: true })
      }

      return next
    })

    // An item that came BACK before its exit finished must not vanish when the
    // stale timer fires.
    for (const key of liveKeys) {
      const t = timers.current.get(key)
      if (t) {
        clearTimeout(t)
        timers.current.delete(key)
      }
    }
  }, [items, keyOf, exitMs, reduced])

  return rendered
}
