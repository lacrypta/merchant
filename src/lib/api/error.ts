/** Thrown with the server's own Spanish message, so callers can render it. */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never reached the server. */
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/**
 * Every failure, in a shape the screens can render.
 *
 * `instanceof ApiError` alone dropped the ones that never reached the server —
 * a refused bunker prompt, an offline phone, a DNS hiccup — and the screen
 * answered a failed load with an empty list and no explanation. A coupon page
 * that silently shows zero coupons is indistinguishable from a merchant who
 * has none.
 */
export function asApiError(error: unknown): ApiError | null {
  if (!error) return null
  if (error instanceof ApiError) return error
  // Status 0, borrowed from XHR: it means "the request never got an answer".
  return new ApiError(
    error instanceof Error && error.message ? error.message : "No pudimos contactar al servidor.",
    0
  )
}
