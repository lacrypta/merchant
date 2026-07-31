"use client"

import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { QueryClient } from "@tanstack/react-query"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import * as React from "react"

/**
 * Local-first data layer.
 *
 * The cache is persisted to IndexedDB, so a returning visitor sees their
 * merchant's name, avatar and catalog on the FIRST paint — before a single
 * websocket has opened — and the network merely confirms it. Relay round
 * trips run six seconds on a bad night; that used to be six seconds of
 * skeletons on every reload.
 *
 * IndexedDB rather than localStorage: the writes are async so they never block
 * paint, and the quota is measured in megabytes rather than ~5MB shared with
 * everything else on the origin.
 */

/** Bump to discard every persisted entry — cheaper than writing a migration. */
const CACHE_BUSTER = "v1"

const MAX_AGE_MS = 7 * 24 * 60 * 60_000

export const QUERY_CACHE_KEY = `mm:query:${CACHE_BUSTER}`

/**
 * Wipe the persisted cache, now, without waiting for the persister.
 *
 * `queryClient.clear()` does notify it, but writes are throttled by a second —
 * so a tab closed inside that window leaves everything on disk, including up to
 * seven days of the previous merchant's zap receipts. Logging out on a shared
 * machine is exactly when that second matters.
 */
export async function clearPersistedQueries(): Promise<void> {
  try {
    await del(QUERY_CACHE_KEY)
  } catch {
    // IndexedDB can be unavailable (private mode, or a browser that refuses it
    // in an iframe). Nothing was persisted in that case either.
  }
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // THE local-first setting. Without it, react-query throws cached data
        // away on mount and every screen starts empty again.
        refetchOnMount: "always",
        // Coming back to the tab is the moment a stale price matters most.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // Relays fail constantly and individually; one retry is honest, five
        // is a hung spinner.
        retry: 1,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        // Anything without an explicit lifetime is still worth keeping.
        gcTime: MAX_AGE_MS,
      },
    },
  })
}

const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get<string>(key).then((v) => v ?? null),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
  key: QUERY_CACHE_KEY,
  throttleTime: 1000,
})

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // One client per browser session, created lazily so a server render never
  // builds one and two tabs never share an instance.
  const [client] = React.useState(makeClient)

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: MAX_AGE_MS,
        buster: CACHE_BUSTER,
        dehydrateOptions: {
          // Persist only what SUCCEEDED. Writing an error state to disk means
          // a failed relay read on Tuesday is still being replayed as the
          // truth on Thursday.
          //
          // Coupons are excluded outright. Everything else here is public data
          // from relays, where a week-old copy is still a true copy; coupons
          // come from our own database behind a NIP-98 signature, and a
          // restored "8 sin usar" would be a stale claim about money written to
          // the disk of whatever machine the merchant happened to log in on.
          shouldDehydrateQuery: (q) =>
            q.state.status === "success" &&
            q.state.data !== undefined &&
            q.queryKey[0] !== "coupons",
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}
