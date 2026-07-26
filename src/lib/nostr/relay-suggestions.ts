/**
 * Popular relays offered as one-tap suggestions in Settings.
 *
 * Every entry below was probed for NIP-11 over HTTPS and is free to write to,
 * except where noted. Keep this list short and honest — suggesting a paid or
 * dead relay produces silent publish failures the merchant can't diagnose.
 */
export interface RelaySuggestion {
  url: string
  label: string
  note: string
}

export const RELAY_SUGGESTIONS: readonly RelaySuggestion[] = [
  {
    url: "wss://relay.damus.io",
    label: "Damus",
    note: "Uno de los relays más grandes y estables.",
  },
  {
    url: "wss://nos.lol",
    label: "nos.lol",
    note: "Gratuito, buena disponibilidad.",
  },
  {
    url: "wss://relay.primal.net",
    label: "Primal",
    note: "Rápido, con buena cobertura de perfiles.",
  },
  {
    url: "wss://relay.nostr.band",
    label: "nostr.band",
    note: "Indexa y facilita las búsquedas.",
  },
  {
    url: "wss://purplepag.es",
    label: "Purple Pages",
    note: "Perfiles y listas de relays. Sólo lectura: rechaza productos.",
  },
  {
    url: "wss://relay.lacrypta.ar",
    label: "La Crypta",
    note: "El relay de la comunidad. Necesario para que el POS te vea.",
  },
  {
    url: "wss://offchain.pub",
    label: "offchain.pub",
    note: "Gratuito, de propósito general.",
  },
  {
    url: "wss://nostr.mom",
    label: "nostr.mom",
    note: "Gratuito, de propósito general.",
  },
] as const
