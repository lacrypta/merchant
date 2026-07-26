import type { SignedEvent, EventTemplate } from "@/lib/nostr/types"

type HasTags = Pick<EventTemplate, "tags">

/** First value of the first tag with this name. */
export function tagValue(e: HasTags, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1]
}

/** All first-values for tags with this name, in event order (order is significant). */
export function tagValues(e: HasTags, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]!)
}

/** The whole first tag row with this name. */
export function firstTag(e: HasTags, name: string): string[] | undefined {
  return e.tags.find((t) => t[0] === name)
}

/** Addressable coordinate: `<kind>:<pubkey>:<d>`. */
export function coordinate(kind: number, pubkey: string, d: string): string {
  return `${kind}:${pubkey}:${d}`
}

/** The coordinate of an addressable event, or null if it isn't addressable. */
export function coordinateOf(e: SignedEvent): string | null {
  if (e.kind < 30000 || e.kind >= 40000) return null
  return coordinate(e.kind, e.pubkey, tagValue(e, "d") ?? "")
}

export function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}
