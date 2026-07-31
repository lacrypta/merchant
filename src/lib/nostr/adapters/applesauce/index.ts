"use client"

/**
 * THE ONLY FILE ALLOWED TO IMPORT applesauce-*.
 *
 * An eslint no-restricted-imports rule enforces this. Everything else in the
 * app codes against the port in src/lib/nostr/types.ts, so swapping the
 * underlying library means rewriting this directory and nothing else.
 *
 * Import paths matter here: applesauce's ROOT barrels export namespaces, so
 * `import { ExtensionAccount } from "applesauce-accounts"` silently fails.
 * The subpaths below were verified against the installed .d.ts files.
 */

import { RelayPool } from "applesauce-relay"
import { NostrConnectSigner, ExtensionSigner } from "applesauce-signers"
import { Permission } from "applesauce-signers/helpers"

import { DEFAULT_RELAYS } from "@/lib/nostr/relays"
import type {
  EventTemplate,
  Nip44Port,
  SignedEvent,
  SignerMethod,
  SignerPort,
} from "@/lib/nostr/types"

/** Relay used for the nostrconnect:// QR handshake. */
export const NOSTR_CONNECT_RELAY = "wss://relay.nsec.app"

/**
 * Kinds this app will ever ask a remote signer to sign.
 *
 * Enumerated deliberately: a blanket `sign_event` grant means the merchant's
 * signer approves anything this origin ever asks for, forever.
 */
export const SIGNING_KINDS = [
  0, // profile
  5, // deletion
  10002, // NIP-65 relay list
  10063, // BUD-03 blossom servers
  24242, // BUD-11 blossom auth
  27235, // NIP-98 HTTP auth (the coupon API)
  30402, // product
  30403, // product draft
  30405, // category
  30078, // NIP-78 app data (WooCommerce config encrypted; coupon endpoints not)
]

/**
 * Everything we ask a remote signer to grant, at connect time.
 *
 * `buildSigningPermissions()` emits ONLY `get_public_key` and
 * `sign_event:<kind>` — NIP-44 encryption is a separate grant. Without asking
 * for it up front, the first `nip44Encrypt` either raises a second approval
 * prompt in the middle of a flow or is refused outright, depending on the
 * bunker.
 *
 * Sessions connected before this existed granted the older list. We pass the
 * new one on restore, so a bunker that re-prompts will ask once more; one that
 * does not will fail the encrypt, which the caller degrades on.
 */
function connectPermissions(): string[] {
  return [
    ...NostrConnectSigner.buildSigningPermissions(SIGNING_KINDS),
    Permission.Nip44Encrypt,
    Permission.Nip44Decrypt,
  ]
}

let pool: RelayPool | undefined
let globalsReady = false

/**
 * NostrConnectSigner reads its transport statics once, inside the constructor
 * (via getConnectionMethods), and THROWS "Missing subscriptionMethod" if they
 * are unset. They must therefore be assigned before ANY signer is
 * constructed — including before restoring a persisted session, which
 * constructs one implicitly.
 */
export function ensureNostrGlobals(): RelayPool {
  if (typeof window === "undefined") {
    throw new Error("nostr backend is browser-only")
  }
  pool ??= new RelayPool()
  if (!globalsReady) {
    NostrConnectSigner.pool = pool
    globalsReady = true
  }
  return pool
}

function toSignedEvent(e: unknown): SignedEvent {
  return e as SignedEvent
}

class ApplesauceSigner implements SignerPort {
  constructor(
    readonly method: SignerMethod,
    private readonly inner: {
      getPublicKey(): Promise<string>
      signEvent(t: EventTemplate): Promise<unknown>
      nip44?: Nip44Port
    }
  ) {}

  /**
   * A live getter, never a snapshot.
   *
   * `ExtensionSigner.nip44` reads `window.nostr?.nip44` on every access, so an
   * extension that injects after we construct the signer would be reported as
   * incapable forever if this were read once in the constructor.
   */
  get nip44(): Nip44Port | undefined {
    return this.inner.nip44
  }

  getPublicKey(): Promise<string> {
    return this.inner.getPublicKey()
  }

  async signEvent(template: EventTemplate): Promise<SignedEvent> {
    return toSignedEvent(await this.inner.signEvent(template))
  }
}

export interface LoginResult {
  pubkey: string
  signer: SignerPort
  /** Opaque resume blob for NIP-46; undefined for extension logins. */
  nbunksec?: string
}

export function isExtensionAvailable(): boolean {
  return typeof window !== "undefined" && !!window.nostr
}

export async function loginWithExtension(): Promise<LoginResult> {
  if (!isExtensionAvailable()) {
    throw new Error(
      "No detectamos una extensión. Probá Alby o nos2x, o usá un firmante remoto."
    )
  }
  ensureNostrGlobals()
  const signer = new ExtensionSigner()
  const pubkey = await signer.getPublicKey()
  return { pubkey, signer: new ApplesauceSigner("nip07", signer) }
}

export async function loginWithBunkerUri(uri: string): Promise<LoginResult> {
  ensureNostrGlobals()
  const signer = await NostrConnectSigner.fromBunkerURI(uri, {
    permissions: connectPermissions(),
  })
  const pubkey = await signer.getPublicKey()
  return {
    pubkey,
    signer: new ApplesauceSigner("nip46", signer),
    nbunksec: await safeNbunksec(signer),
  }
}

export interface NostrConnectHandle {
  uri: string
  /** Resolves when the remote signer approves. Rejects on abort/timeout. */
  waitForSigner: Promise<LoginResult>
  cancel(): void
}

export function startNostrConnect(metadata: {
  name: string
  url: string
  image?: string
}): NostrConnectHandle {
  ensureNostrGlobals()

  const permissions = connectPermissions()
  const signer = new NostrConnectSigner({ relays: [NOSTR_CONNECT_RELAY] })
  const controller = new AbortController()

  const uri = signer.getNostrConnectURI({ ...metadata, permissions })

  const waitForSigner = (async (): Promise<LoginResult> => {
    // applesauce verifies the `secret` echo-back internally — do not
    // hand-roll that check.
    await signer.waitForSigner(controller.signal)
    const pubkey = await signer.getPublicKey()
    return {
      pubkey,
      signer: new ApplesauceSigner("nip46", signer),
      nbunksec: await safeNbunksec(signer),
    }
  })()

  return {
    uri,
    waitForSigner,
    cancel: () => controller.abort(),
  }
}

/** Restore a NIP-46 session from its nbunksec blob. */
export async function restoreFromNbunksec(nbunksec: string): Promise<LoginResult> {
  ensureNostrGlobals()
  // NOTE: fromNbunksec takes NO `signer` option — the client keypair is
  // rebuilt from the blob's own clientKey.
  const signer = await NostrConnectSigner.fromNbunksec(nbunksec, {
    permissions: connectPermissions(),
  })
  const pubkey = await signer.getPublicKey()
  return { pubkey, signer: new ApplesauceSigner("nip46", signer), nbunksec }
}

async function safeNbunksec(
  signer: NostrConnectSigner
): Promise<string | undefined> {
  try {
    return await signer.getNbunksec()
  } catch {
    return undefined
  }
}

export async function logoutSigner(signer: SignerPort): Promise<void> {
  const inner = signer as unknown as { inner?: { logout?: () => Promise<void> } }
  try {
    await inner.inner?.logout?.()
  } catch {
    /* remote already gone */
  }
}

export { DEFAULT_RELAYS }
