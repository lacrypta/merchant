"use client"

import { useMediaQuery } from "@/hooks/use-media-query"

/**
 * Whether the visitor asked the OS to reduce motion.
 *
 * globals.css already flattens CSS animations under this query, but anything
 * JS decides to render — a digit reel, a mounted-then-unmounted exit
 * transition — has to check it itself.
 *
 * Defaults to FALSE during SSR, matching the CSS default, so the first client
 * paint agrees with the server.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
