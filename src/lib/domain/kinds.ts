/** Every nostr event kind this app reads or writes. */
export const KINDS = {
  /** NIP-01 profile metadata */
  METADATA: 0,
  /** NIP-09 deletion request */
  DELETION: 5,
  /** NIP-65 relay list metadata */
  RELAY_LIST: 10002,
  /** NIP-57 zap request — signed, never published; sent to the LNURL callback */
  ZAP_REQUEST: 9734,
  /** NIP-57 zap receipt — published by the Lightning provider on payment */
  ZAP_RECEIPT: 9735,
  /** BUD-03 user blossom server list */
  BLOSSOM_SERVERS: 10063,
  /** BUD-11 blossom authorization */
  BLOSSOM_AUTH: 24242,
  /** NIP-99 classified listing — active */
  PRODUCT: 30402,
  /** NIP-99 classified listing — draft / inactive */
  PRODUCT_DRAFT: 30403,
  /** GammaMarkets product collection — we use it as a category */
  CATEGORY: 30405,
} as const

export type Kind = (typeof KINDS)[keyof typeof KINDS]
