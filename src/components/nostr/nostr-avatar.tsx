"use client"

import * as React from "react"

import { useNostrProfile } from "@/hooks/use-nostr-profile"
import { initialsFor, profileLabel } from "@/lib/domain/profile"
import { cn } from "@/lib/utils"

/**
 * Avatar for any npub in the app.
 *
 * Uses a plain <img>, not next/image, on purpose: kind-0 `picture` is an
 * arbitrary attacker-controlled URL and no `remotePatterns` allowlist can
 * cover "any host a merchant chose". `referrerPolicy="no-referrer"` keeps
 * the visited page out of that host's logs.
 */
export function NostrAvatar({
  pubkey,
  npub,
  size = 32,
  className,
}: {
  pubkey: string | null
  npub: string
  size?: number
  className?: string
}) {
  const { profile } = useNostrProfile(pubkey)

  const label = profileLabel(profile, npub)
  const src = profile?.picture

  // Remember WHICH url failed rather than a boolean, so the fallback state
  // resets itself when the source changes. A boolean would need an effect to
  // clear it, and would otherwise pin this avatar to initials forever after
  // one transient error.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null)
  const failed = !!src && failedSrc === src

  const shared = cn(
    "shrink-0 rounded-full object-cover ring-1 ring-border",
    className
  )

  if (!src || failed) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
        className={cn(
          shared,
          "grid place-items-center bg-secondary font-bold text-muted-foreground"
        )}
      >
        {initialsFor(label)}
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
      style={{ width: size, height: size }}
      className={shared}
    />
  )
}
