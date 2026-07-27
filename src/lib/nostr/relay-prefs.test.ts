import { beforeEach, describe, expect, it } from "vitest"

import {
  __resetRelayPrefs,
  enabledRelays,
  isRelayEnabled,
  readRelayEntries,
  setRelayEnabled,
  writeRelayEntries,
} from "./relay-prefs"
import { writeRelays, type RelayEntry } from "@/lib/domain/relay-list"

const A = "wss://relay.damus.io"
const B = "wss://nos.lol"

/** jsdom is not configured for this suite, so stand in for localStorage. */
beforeEach(() => {
  __resetRelayPrefs()
  const store = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
})

const entry = (url: string, read: boolean): RelayEntry => ({
  url,
  read,
  write: read,
  source: "manual",
})

describe("isRelayEnabled", () => {
  it("allows a relay nobody has an opinion about", () => {
    // Defaults ship enabled; an empty record must not mean "everything off".
    expect(isRelayEnabled(A, [])).toBe(true)
  })

  it("respects an explicit off", () => {
    expect(isRelayEnabled(A, [entry(A, false)])).toBe(false)
  })

  it("matches regardless of a trailing slash", () => {
    // applesauce normalises URLs with a trailing slash; the record does not.
    expect(isRelayEnabled(`${A}/`, [entry(A, false)])).toBe(false)
  })
})

describe("enabledRelays", () => {
  it("removes the relays that were switched off", () => {
    setRelayEnabled(A, false)
    expect(enabledRelays([A, B])).toEqual([B])
  })

  it("NEVER returns an empty list from a non-empty one", () => {
    // Switching every relay off would otherwise turn the app into an offline
    // shell with no error and no explanation. Falling back to the full list
    // is visibly wrong-but-working, which is the better failure.
    setRelayEnabled(A, false)
    setRelayEnabled(B, false)
    expect(enabledRelays([A, B])).toEqual([A, B])
  })

  it("passes an empty input straight through", () => {
    expect(enabledRelays([])).toEqual([])
  })

  it("re-enabling restores the relay", () => {
    setRelayEnabled(A, false)
    expect(enabledRelays([A, B])).toEqual([B])
    setRelayEnabled(A, true)
    expect(enabledRelays([A, B])).toEqual([A, B])
  })
})

describe("setRelayEnabled and publishing", () => {
  it("stops publishing to a relay that was switched off", () => {
    // The requirement: a disabled relay must not receive events.
    writeRelayEntries([{ url: A, read: true, write: true, source: "manual" }])
    setRelayEnabled(A, false)
    expect(readRelayEntries()[0]).toMatchObject({ read: false, write: false })
    expect(writeRelays(readRelayEntries())).toEqual([])
  })

  it("drops a disabled relay from the write set among others", () => {
    writeRelayEntries([
      { url: A, read: true, write: true, source: "manual" },
      { url: B, read: true, write: true, source: "manual" },
    ])
    setRelayEnabled(A, false)
    expect(writeRelays(readRelayEntries())).toEqual([B])
  })

  it("switches a default relay fully off in one go", () => {
    setRelayEnabled(A, false)
    expect(readRelayEntries()[0]).toMatchObject({ read: false, write: false })
  })

  it("restores reads and writes when switched back on", () => {
    setRelayEnabled(A, false)
    setRelayEnabled(A, true)
    expect(readRelayEntries()[0]).toMatchObject({ read: true, write: true })
  })

  it("never turns purplepag.es writable", () => {
    // It rejects kind 30402 outright; see READ_ONLY_BY_DEFAULT.
    const url = "wss://purplepag.es"
    setRelayEnabled(url, false)
    setRelayEnabled(url, true)
    expect(readRelayEntries()[0]).toMatchObject({ read: true, write: false })
  })

  it("counts a write-only relay as in use", () => {
    // Off means BOTH flags down. Reporting a write-only relay as off would
    // invite a toggle that silently changes what it does.
    const entries = [{ url: A, read: false, write: true, source: "manual" as const }]
    expect(isRelayEnabled(A, entries)).toBe(true)
    // ...but it must still never be queried.
    writeRelayEntries(entries)
    expect(enabledRelays([A, B])).toEqual([B])
  })
})

describe("stale cache", () => {
  it("picks up a write that bypassed writeRelayEntries", () => {
    // Same-tab external writes fire no `storage` event. Caching on a "loaded
    // once" flag made the panel and the actual reads disagree silently.
    expect(enabledRelays([A, B])).toEqual([A, B])
    window.localStorage.setItem(
      "mm:relays",
      JSON.stringify([{ url: A, read: false, write: true, source: "manual" }])
    )
    expect(enabledRelays([A, B])).toEqual([B])
  })

  it("returns a stable reference while nothing changes", () => {
    // useSyncExternalStore tears on a fresh array per call.
    setRelayEnabled(A, false)
    expect(readRelayEntries()).toBe(readRelayEntries())
  })

  it("survives a corrupted record", () => {
    window.localStorage.setItem("mm:relays", "{not json")
    expect(readRelayEntries()).toEqual([])
    expect(enabledRelays([A, B])).toEqual([A, B])
  })

  it("ignores a record that is not an array", () => {
    window.localStorage.setItem("mm:relays", '{"url":"wss://x"}')
    expect(readRelayEntries()).toEqual([])
  })
})
