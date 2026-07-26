"use client"

import * as React from "react"

/**
 * SSR-safe media query. Returns `false` on the server and on the first client
 * render, then settles after mount — so the hydrated tree always matches.
 *
 * Because the initial value is always `false`, callers must be written
 * mobile-first: the `false` branch is what renders on the server.
 *
 * Prefer CSS (`hidden lg:flex`) for pure layout switches. Use this hook only
 * where the COMPONENT IDENTITY must change (e.g. Dialog vs Drawer).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    [query]
  )

  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false // server snapshot — mobile-first
  )
}

/** Matches the `lg` breakpoint used for the sidebar/tab-bar switch. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)")
}
