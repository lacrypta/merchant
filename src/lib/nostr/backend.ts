/**
 * Composition root for the nostr backend.
 *
 * This is the ONLY module outside src/lib/nostr/adapters/** allowed to touch
 * the adapter, and it is listed as an exception in the eslint quarantine
 * rule. Application code (components, hooks) imports from here, so swapping
 * applesauce for something else means rewriting the adapter directory and
 * this file's imports — nothing more.
 */

export {
  isExtensionAvailable,
  loginWithExtension,
  loginWithBunkerUri,
  startNostrConnect,
  restoreFromNbunksec,
  ensureNostrGlobals,
  SIGNING_KINDS,
  NOSTR_CONNECT_RELAY,
} from "@/lib/nostr/adapters/applesauce"

export type {
  LoginResult,
  NostrConnectHandle,
} from "@/lib/nostr/adapters/applesauce"

export {
  publishEvent,
  publishEventStreaming,
  queryEvents,
  subscribeEvents,
  relayStatuses,
} from "@/lib/nostr/adapters/applesauce/relays"

export type { RelayProgress } from "@/lib/nostr/adapters/applesauce/relays"
