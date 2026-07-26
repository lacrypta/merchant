import { useMediaQuery } from "@/hooks/use-media-query"

const MOBILE_BREAKPOINT = 768

/**
 * Kept for the shadcn `sidebar` component, which imports it by name.
 *
 * Delegates to useMediaQuery (useSyncExternalStore) rather than shadcn's
 * generated setState-in-effect version: that pattern trips
 * react-hooks/set-state-in-effect and causes a cascading render on mount.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}
