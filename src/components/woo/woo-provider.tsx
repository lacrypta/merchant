"use client"

import * as React from "react"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import {
  WOO_CONFIG_D,
  parseWooConnection,
  serializeWooConnection,
  type WooConnection,
} from "@/lib/domain/woo-config"
import {
  EMPTY_SYNC_STATE,
  WOO_SYNC_D,
  parseWooSyncState,
  serializeWooSyncState,
  type WooSyncState,
} from "@/lib/domain/woo-sync-state"
import { canEncrypt, decryptFromSelf, encryptToSelf } from "@/lib/nostr/self-encrypt"
import { tagValue } from "@/lib/nostr/tags"

/**
 * The WooCommerce connection, decrypted once per session.
 *
 * Decryption is not free: on NIP-46 every call is a round trip to the bunker,
 * in the same latency class as signing. So it happens once when the app-data
 * events arrive and the result is held in memory — never on each render, and
 * never per request.
 */

type LoadState = "idle" | "loading" | "ready" | "no-signer" | "cannot-decrypt"

interface WooContextValue {
  /** null when never connected, or when the blob could not be read. */
  connection: WooConnection | null
  syncState: WooSyncState
  state: LoadState
  /** False when the signer has no NIP-44 — the connection cannot be stored. */
  canStore: boolean
  connect: (c: WooConnection) => Promise<void>
  disconnect: () => Promise<void>
  saveSyncState: (next: WooSyncState) => Promise<void>
  /** Set when the last read or write failed, for the UI to surface. */
  error: string | null
}

const WooContext = React.createContext<WooContextValue | null>(null)

export function WooProvider({ children }: { children: React.ReactNode }) {
  const { state: auth, signer } = useAuth()
  const { appData, publishAppData } = useCatalog()
  const pubkey = auth.status === "ready" ? auth.pubkey : null

  const [connection, setConnection] = React.useState<WooConnection | null>(null)
  const [syncState, setSyncState] = React.useState<WooSyncState>(EMPTY_SYNC_STATE)
  const [state, setState] = React.useState<LoadState>("idle")
  const [error, setError] = React.useState<string | null>(null)

  const configEvent = React.useMemo(
    () => appData.find((e) => tagValue(e, "d") === WOO_CONFIG_D),
    [appData]
  )
  const syncEvent = React.useMemo(
    () => appData.find((e) => tagValue(e, "d") === WOO_SYNC_D),
    [appData]
  )

  /**
   * Keyed on the event ids, not the event objects: react-query hands back a
   * new array on every refetch even when nothing changed, and re-decrypting on
   * NIP-46 would mean a bunker round trip every time the catalog refreshes.
   */
  const configId = configEvent?.id
  const syncId = syncEvent?.id

  React.useEffect(() => {
    let cancelled = false

    // Deferred: a synchronous setState in an effect body cascades a render,
    // and every branch below sets state. Same idiom as CatalogProvider's
    // NIP-65 adoption effect.
    const timer = setTimeout(() => void run(), 0)

    async function run() {
      if (cancelled) return
      if (!pubkey || !signer) {
        setState("no-signer")
        return
      }
      if (!configEvent && !syncEvent) {
        setConnection(null)
        setSyncState(EMPTY_SYNC_STATE)
        setState("ready")
        return
      }
      if (!canEncrypt(signer)) {
        setState("cannot-decrypt")
        return
      }

      setState("loading")

      try {
        if (configEvent?.content) {
          const plain = await decryptFromSelf(signer, pubkey, configEvent.content)
          const parsed = parseWooConnection(plain)
          if (cancelled) return
          // A blob we cannot parse is "no connection", never "empty
          // connection" — the difference decides whether we would overwrite it.
          setConnection(parsed.ok ? parsed.value : null)
          if (!parsed.ok) setError(`Config ilegible: ${parsed.reason}`)
        } else {
          setConnection(null)
        }

        if (syncEvent?.content) {
          const plain = await decryptFromSelf(signer, pubkey, syncEvent.content)
          if (cancelled) return
          setSyncState(parseWooSyncState(plain))
        }

        if (!cancelled) setState("ready")
      } catch {
        if (!cancelled) {
          // Most likely another app's blob under a `d` we happen to share.
          setState("cannot-decrypt")
        }
      }
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, signer, configId, syncId])

  const connect = React.useCallback(
    async (c: WooConnection) => {
      if (!pubkey || !signer) throw new Error("Ingresá con Nostr primero.")
      setError(null)
      const sealed = await encryptToSelf(signer, pubkey, serializeWooConnection(c))
      publishAppData(WOO_CONFIG_D, sealed, "Conexión con WooCommerce")
      setConnection(c)
    },
    [pubkey, signer, publishAppData]
  )

  /**
   * Publishing an empty blob rather than a kind-5 deletion.
   *
   * A deletion asks relays to forget the event; an empty replacement is
   * something we control and can verify. Either way the credentials are gone
   * from our side — but the merchant must still revoke the key in WooCommerce,
   * which the UI says out loud.
   */
  const disconnect = React.useCallback(async () => {
    if (!pubkey || !signer) return
    setError(null)
    const sealed = await encryptToSelf(signer, pubkey, JSON.stringify({ v: 0 }))
    publishAppData(WOO_CONFIG_D, sealed, "Desconectar WooCommerce")
    setConnection(null)
  }, [pubkey, signer, publishAppData])

  const saveSyncState = React.useCallback(
    async (next: WooSyncState) => {
      if (!pubkey || !signer) return
      const sealed = await encryptToSelf(signer, pubkey, serializeWooSyncState(next))
      publishAppData(WOO_SYNC_D, sealed, "Registro de sincronización")
      setSyncState(next)
    },
    [pubkey, signer, publishAppData]
  )

  const value = React.useMemo<WooContextValue>(
    () => ({
      connection,
      syncState,
      state,
      canStore: canEncrypt(signer),
      connect,
      disconnect,
      saveSyncState,
      error,
    }),
    [connection, syncState, state, signer, connect, disconnect, saveSyncState, error]
  )

  return <WooContext.Provider value={value}>{children}</WooContext.Provider>
}

export function useWoo(): WooContextValue {
  const ctx = React.useContext(WooContext)
  if (!ctx) throw new Error("useWoo must be used inside WooProvider")
  return ctx
}
