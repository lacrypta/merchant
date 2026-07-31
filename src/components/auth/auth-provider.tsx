"use client"

import { useQueryClient } from "@tanstack/react-query"
import { nip19 } from "nostr-tools"
import * as React from "react"

import { clearPersistedQueries } from "@/components/providers/query-provider"
import { clearApiSession } from "@/lib/api/session"
import {
  isExtensionAvailable,
  loginWithBunkerUri,
  loginWithExtension,
  restoreFromNbunksec,
  startNostrConnect,
  type NostrConnectHandle,
} from "@/lib/nostr/backend"
import type { SignerMethod, SignerPort } from "@/lib/nostr/types"

/**
 * Auth state machine.
 *
 * `booting` is emitted on the SERVER and on the client's first render, so the
 * hydrated tree matches byte-for-byte. Session restore happens in an effect,
 * never during render — window.nostr is injected after hydration and
 * localStorage doesn't exist during SSR.
 */
export type AuthState =
  | { status: "booting" }
  | { status: "anonymous" }
  | { status: "connecting"; method: SignerMethod }
  | { status: "ready"; pubkey: string; npub: string; method: SignerMethod }
  | { status: "error"; message: string }

const SESSION_KEY = "mm:session"

type PersistedSession =
  | { method: "nip07"; pubkey: string }
  | { method: "nip46"; pubkey: string; nbunksec: string }

interface AuthContextValue {
  state: AuthState
  signer: SignerPort | null
  extensionAvailable: boolean
  loginExtension: () => Promise<void>
  loginBunker: (uri: string) => Promise<void>
  startQrLogin: () => NostrConnectHandle | null
  completeQrLogin: (handle: NostrConnectHandle) => Promise<void>
  logout: () => void
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

function readSession(): PersistedSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as PersistedSession) : null
  } catch {
    return null
  }
}

function writeSession(s: PersistedSession) {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    /* private mode / quota */
  }
}

function clearSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY)
  } catch {
    /* noop */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({ status: "booting" })
  const [signer, setSigner] = React.useState<SignerPort | null>(null)
  const [extensionAvailable, setExtensionAvailable] = React.useState(false)
  const client = useQueryClient()
  /** Who was logged in last, to notice a switch. A ref: it must not render. */
  const lastPubkey = React.useRef<string | null>(null)

  /**
   * Forget everything that belonged to the account being left behind.
   *
   * Hygiene rather than correctness, and worth saying so: every cached key
   * already contains the pubkey it belongs to (see src/lib/query/keys.ts), so
   * the next merchant literally cannot read the previous one's entries. What
   * this stops is their data SITTING on a shared machine — up to seven days of
   * zap receipts in IndexedDB — and a bearer token outliving its owner.
   *
   * `clear()` and not a list of keys to remove: a list is something the next
   * person to add a pubkey-scoped query will forget to extend, which is the
   * exact failure the key factory exists to prevent. It also empties the
   * mutation cache, which removeQueries does not.
   */
  const resetAccountData = React.useCallback(() => {
    clearApiSession()
    client.clear()
    void clearPersistedQueries()
  }, [client])

  const apply = React.useCallback(
    (pubkey: string, s: SignerPort, method: SignerMethod) => {
      // Switching accounts without logging out is routine — an extension can do
      // it, and the login dialog is reachable while already signed in. On boot
      // the ref is null, so a restored session keeps its cache, which is the
      // whole point of persisting it.
      if (lastPubkey.current && lastPubkey.current !== pubkey) resetAccountData()
      lastPubkey.current = pubkey

      setSigner(s)
      setState({
        status: "ready",
        pubkey,
        npub: nip19.npubEncode(pubkey),
        method,
      })
    },
    [resetAccountData]
  )

  // Extensions inject window.nostr AFTER hydration, so poll briefly.
  React.useEffect(() => {
    let tries = 0
    const id = window.setInterval(() => {
      if (isExtensionAvailable()) {
        setExtensionAvailable(true)
        window.clearInterval(id)
      } else if (++tries > 30) {
        window.clearInterval(id)
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [])

  // Restore session. Never during render.
  React.useEffect(() => {
    let cancelled = false
    const saved = readSession()

    // Deliberately inside the async IIFE: a synchronous setState in an effect
    // body triggers a cascading render, and localStorage cannot be read
    // during render (it doesn't exist under SSR).
    void (async () => {
      if (!saved) {
        if (!cancelled) setState({ status: "anonymous" })
        return
      }
      try {
        if (saved.method === "nip46") {
          const r = await restoreFromNbunksec(saved.nbunksec)
          if (cancelled) return
          apply(r.pubkey, r.signer, "nip46")
          return
        }

        // Extension: re-check the pubkey still matches. If the merchant
        // switched accounts in Alby, silently publishing from the wrong key
        // would be far worse than forcing a fresh login.
        const r = await loginWithExtension()
        if (cancelled) return
        if (r.pubkey !== saved.pubkey) {
          // The bearer goes with it: we just decided this session is not who it
          // claimed to be, and leaving its token on disk contradicts that.
          // Harmless in practice — readStored checks the pubkey too — but a
          // credential should never outlive the session that earned it.
          clearApiSession()
          clearSession()
          setState({ status: "anonymous" })
          return
        }
        apply(r.pubkey, r.signer, "nip07")
      } catch {
        if (cancelled) return
        clearApiSession()
        clearSession()
        setState({ status: "anonymous" })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [apply])

  const loginExtension = React.useCallback(async () => {
    setState({ status: "connecting", method: "nip07" })
    try {
      const r = await loginWithExtension()
      writeSession({ method: "nip07", pubkey: r.pubkey })
      apply(r.pubkey, r.signer, "nip07")
    } catch (e) {
      setState({
        status: "error",
        message: e instanceof Error ? e.message : "No pudimos conectar.",
      })
      throw e
    }
  }, [apply])

  const loginBunker = React.useCallback(
    async (uri: string) => {
      setState({ status: "connecting", method: "nip46" })
      try {
        const r = await loginWithBunkerUri(uri)
        if (r.nbunksec) {
          writeSession({ method: "nip46", pubkey: r.pubkey, nbunksec: r.nbunksec })
        }
        apply(r.pubkey, r.signer, "nip46")
      } catch (e) {
        setState({
          status: "error",
          message:
            e instanceof Error ? e.message : "No pudimos conectar con el bunker.",
        })
        throw e
      }
    },
    [apply]
  )

  const startQrLogin = React.useCallback(() => {
    try {
      return startNostrConnect({
        name: "Merchant Manager",
        url: window.location.origin,
        image: `${window.location.origin}/icon.svg`,
      })
    } catch {
      return null
    }
  }, [])

  const completeQrLogin = React.useCallback(
    async (handle: NostrConnectHandle) => {
      setState({ status: "connecting", method: "nip46" })
      try {
        const r = await handle.waitForSigner
        if (r.nbunksec) {
          writeSession({ method: "nip46", pubkey: r.pubkey, nbunksec: r.nbunksec })
        }
        apply(r.pubkey, r.signer, "nip46")
      } catch (e) {
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "La conexión falló.",
        })
        throw e
      }
    },
    [apply]
  )

  const logout = React.useCallback(() => {
    // The credential goes first: if anything below throws, the worst state left
    // behind is a warm cache with no way to authenticate against it.
    resetAccountData()
    lastPubkey.current = null
    clearSession()
    setSigner(null)
    setState({ status: "anonymous" })
  }, [resetAccountData])

  const value = React.useMemo<AuthContextValue>(
    () => ({
      state,
      signer,
      extensionAvailable,
      loginExtension,
      loginBunker,
      startQrLogin,
      completeQrLogin,
      logout,
    }),
    [
      state,
      signer,
      extensionAvailable,
      loginExtension,
      loginBunker,
      startQrLogin,
      completeQrLogin,
      logout,
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}

/** Truncated npub for chips: npub1abc…x9k */
export function shortNpub(npub: string): string {
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`
}
