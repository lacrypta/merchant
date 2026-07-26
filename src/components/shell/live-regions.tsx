/**
 * Two singleton live regions, mounted once in the shell.
 *
 * polite    → publish progress, save confirmations, reorder announcements,
 *             search result counts, zoom level
 * assertive → publish failures, signer rejection, offline
 *
 * Sonner toasts announce themselves; route only NON-toast events through
 * these, or screen readers hear everything twice.
 */
export function LiveRegions() {
  return (
    <>
      <div
        id="lr-polite"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
      <div
        id="lr-assertive"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      />
    </>
  )
}
