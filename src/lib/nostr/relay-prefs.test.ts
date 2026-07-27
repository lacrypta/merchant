import { beforeEach, describe, expect, it } from "vitest"

import {
  __resetRelayPrefs,
  enabledRelays,
  isRelayEnabled,
  readRelayEntries,
  setRelayEnabled,
  writeRelayEntries,
} from "./relay-prefs"
import type { RelayEntry } from "@/lib/domain/relay-list"

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

describe("setRelayEnabled and the write set", () => {
  it("leaves an existing relay's write flag alone", () => {
    // The panel's switch is the "Leer" setting. Turning it off must not stop
    // the merchant's catalog from being published there.
    writeRelayEntries([{ url: A, read: true, write: true, source: "manual" }])
    setRelayEnabled(A, false)
    expect(readRelayEntries()[0]).toMatchObject({ read: false, write: true })
  })

  it("restores only reads when re-enabled", () => {
    writeRelayEntries([{ url: A, read: true, write: false, source: "manual" }])
    setRelayEnabled(A, false)
    setRelayEnabled(A, true)
    // write stays false — a deliberately read-only relay must not become
    // writable just because it was toggled off and on again.
    expect(readRelayEntries()[0]).toMatchObject({ read: true, write: false })
  })

  it("materialises a default relay as writable", () => {
    setRelayEnabled(A, false)
    expect(readRelayEntries()[0]).toMatchObject({ read: false, write: true })
  })

  it("never materialises purplepag.es as writable", () => {
    // It rejects kind 30402 outright; see READ_ONLY_BY_DEFAULT.
    setRelayEnabled("wss://purplepag.es", false)
    expect(readRelayEntries()[0]).toMatchObject({ write: false })
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
