import type { SignerPort } from "@/lib/nostr/types"

/**
 * NIP-44 encryption addressed to the merchant's OWN pubkey.
 *
 * NIP-44 derives its conversation key from ECDH between two keys; using the
 * same key on both sides is a legitimate degenerate case and is how every
 * nostr client stores private app data. Nobody but the key holder can read it,
 * and it needs no second party.
 *
 * This exists as its own module so there is exactly one place that decides
 * what happens when a signer cannot encrypt. Scattering `signer.nip44?` checks
 * would eventually produce one that forgot, and the failure mode there is
 * publishing a merchant's API credentials in the clear on public relays.
 */

/** Thrown instead of falling back to plaintext. Never caught to "try anyway". */
export class SignerCannotEncryptError extends Error {
  constructor() {
    super(
      "Tu firmante no puede cifrar (NIP-44). Probá con una extensión más nueva o un firmante remoto."
    )
    this.name = "SignerCannotEncryptError"
  }
}

/** Thrown when the ciphertext is not ours to read, or is corrupt. */
export class DecryptFailedError extends Error {
  constructor(cause?: unknown) {
    super("No pudimos descifrar los datos guardados.")
    this.name = "DecryptFailedError"
    this.cause = cause
  }
}

/**
 * Can this signer encrypt at all?
 *
 * NIP-46 always can. NIP-07 depends on the extension — `window.nostr.nip44` is
 * optional in the spec and older builds of common extensions omit it.
 */
export function canEncrypt(signer: SignerPort | null | undefined): boolean {
  return !!signer?.nip44
}

export async function encryptToSelf(
  signer: SignerPort,
  pubkey: string,
  plaintext: string
): Promise<string> {
  if (!signer.nip44) throw new SignerCannotEncryptError()
  return signer.nip44.encrypt(pubkey, plaintext)
}

/**
 * @throws DecryptFailedError — including for a payload written by a DIFFERENT
 *   app under a `d` tag we happen to share. Callers treat that as "no config",
 *   never as "empty config", because overwriting it would destroy another
 *   app's data.
 */
export async function decryptFromSelf(
  signer: SignerPort,
  pubkey: string,
  ciphertext: string
): Promise<string> {
  if (!signer.nip44) throw new SignerCannotEncryptError()
  try {
    return await signer.nip44.decrypt(pubkey, ciphertext)
  } catch (e) {
    throw new DecryptFailedError(e)
  }
}
