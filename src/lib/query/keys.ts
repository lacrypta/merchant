/**
 * Every query key in one place.
 *
 * Keys are the cache's primary keys AND its invalidation surface, so a typo
 * in a string literal three components away is a silent cache miss that looks
 * like a slow network. A factory makes that a type error instead.
 */
export const qk = {
  /** BTC exchange rates. Parameterless — one entry for everyone. */
  rates: () => ["rates"] as const,

  /** kind-0 metadata for one pubkey. */
  profile: (pubkey: string) => ["profile", pubkey] as const,

  /** NIP-05 round trip for one claimed address, scoped to the pubkey it claims. */
  nip05: (address: string, pubkey: string) => ["nip05", address, pubkey] as const,

  /** The merchant's own catalog, as published on relays. */
  catalog: (pubkey: string) => ["catalog", pubkey] as const,

  /** The issued instances of ONE coupon, loaded when the merchant opens it. */
  couponMints: (couponId: string) => ["coupon-mints", couponId] as const,

  /** Zap receipts paid to one merchant, projected into their order book. */
  orders: (pubkey: string) => ["orders", pubkey] as const,

  /**
   * The merchant's coupons and authorized minters, from OUR Postgres.
   *
   * The only key here that is not backed by nostr, which is why it is the only
   * one that must never be served from the persisted cache — see CACHE.coupons.
   */
  coupons: (pubkey: string) => ["coupons", pubkey] as const,

  /** Raw events this app published with the merchant's key — the /products/events inspector. */
  events: (pubkey: string) => ["events", pubkey] as const,
} as const

/**
 * Cache lifetimes, by how expensive the data is to be wrong about.
 *
 * `staleTime` is when a background refetch is allowed; `gcTime` is how long
 * the entry survives with nobody watching. Local-first means gcTime is
 * generous — the persisted cache is the whole point — while staleTime stays
 * short enough that a screen never shows yesterday's prices as if they were
 * current.
 */
export const CACHE = {
  /** A rate older than a minute gets refreshed behind the reader's back. */
  rates: { staleTime: 60_000, gcTime: 24 * 60 * 60_000 },
  /** Display names and avatars change rarely and cost a relay round trip. */
  profile: { staleTime: 30 * 60_000, gcTime: 7 * 24 * 60 * 60_000 },
  /** NIP-05 is identification, not verification: recheck, but not constantly. */
  nip05: { staleTime: 60 * 60_000, gcTime: 7 * 24 * 60 * 60_000 },
  /** The merchant's own catalog — refetch on every visit, keep for a week. */
  catalog: { staleTime: 30_000, gcTime: 7 * 24 * 60 * 60_000 },
  /** Receipts are append-only; refresh them on each visit, retain history locally. */
  orders: { staleTime: 30_000, gcTime: 7 * 24 * 60 * 60_000 },
  /**
   * Coupons get a SHORT gcTime, unlike everything else here.
   *
   * The rest of this cache is local-first because relays are the source of
   * truth and a week-old catalog is still the merchant's catalog. Coupons live
   * in our database, and "12 claimed" from last Tuesday is not stale data — it
   * is a wrong number about money. Ten minutes keeps a tab switch instant
   * without ever surviving a session.
   */
  coupons: { staleTime: 15_000, gcTime: 10 * 60_000 },
  /** The inspector mirrors whatever relays hold right now; refetch each visit. */
  events: { staleTime: 30_000, gcTime: 7 * 24 * 60 * 60_000 },
} as const
