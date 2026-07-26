import type { EventTemplate, SignedEvent } from "@/lib/nostr/types"

/**
 * NIP-07 browser extension API.
 *
 * Injected AFTER hydration, so `window.nostr` must never be read during
 * render — only inside an effect or an event handler.
 */
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<SignedEvent>
      getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
      nip44?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
    }
  }
}

export {}
