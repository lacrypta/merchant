/**
 * The library-agnostic nostr port.
 *
 * THIS FILE MUST NOT IMPORT ANY NOSTR LIBRARY. Everything in the app codes
 * against these types; all applesauce-specific code lives in
 * src/lib/nostr/adapters/**, enforced by an eslint no-restricted-imports rule.
 */

export interface EventTemplate {
  kind: number
  created_at: number
  content: string
  tags: string[][]
}

export interface SignedEvent extends EventTemplate {
  id: string
  pubkey: string
  sig: string
}

export interface Filter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [key: `#${string}`]: string[] | undefined | number | number[] | string
}

export type SignerMethod = "nip07" | "nip46"

export interface SignerPort {
  readonly method: SignerMethod
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<SignedEvent>
}

/** Per-relay publish outcome. Publishing is NEVER a boolean. */
export interface PublishReport {
  event: SignedEvent
  ok: string[]
  failed: { relay: string; reason: string }[]
}

export type Unsubscribe = () => void

export interface RelayPort {
  publish(
    event: SignedEvent,
    relays: string[],
    opts?: { timeoutMs?: number }
  ): Promise<PublishReport>
  subscribe(
    filters: Filter[],
    relays: string[],
    handlers: { event: (e: SignedEvent) => void; eose?: () => void }
  ): Unsubscribe
  query(
    filters: Filter[],
    relays: string[],
    opts?: { timeoutMs?: number }
  ): Promise<SignedEvent[]>
}
