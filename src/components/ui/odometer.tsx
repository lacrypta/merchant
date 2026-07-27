"use client"

import * as React from "react"

import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { cn } from "@/lib/utils"

/**
 * A number that rolls to its new value instead of blinking to it.
 *
 * Prices change for reasons the reader did not cause — a rate refresh, a
 * background sync — and a figure that silently swaps is a figure nobody
 * notices changed. Rolling the digits makes the change legible without a
 * toast or a highlight.
 *
 * Digits are laid out from the RIGHT: adding a thousands digit must not
 * reshuffle every reel to its left, or "999 → 1.000" animates as four
 * unrelated spins instead of one carry.
 */
export function Odometer({
  value,
  format,
  className,
}: {
  value: number
  /** Produce the display string. Grouping separators are fine — they render
   *  as static characters and only the digits animate. */
  format: (n: number) => string
  className?: string
}) {
  const reduced = useReducedMotion()
  const text = format(value)

  // Reduced motion gets the plain string: a vestibular trigger is not worth a
  // flourish, and the number is equally readable either way.
  if (reduced) {
    return <span className={cn("numeric", className)}>{text}</span>
  }

  const chars = [...text]

  return (
    <span className={cn("numeric inline-flex leading-none", className)}>
      {/*
        The reels carry all ten digits per place, so they are noise to anything
        that reads the DOM — screen readers, copy-paste, page-text extraction.
        A visually-hidden copy of the real string is what those get.

        Deliberately NOT role="text" + aria-label on the wrapper: role="text"
        is a Safari-ism rather than an ARIA role, and aria-label on a generic
        span is ignored by several screen readers.
      */}
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex flex-row-reverse">
        {[...chars].reverse().map((ch, i) => (
          <Char
            // Keyed from the right so a new leading digit pushes the row out
            // rather than renumbering every existing reel.
            key={`${chars.length - 1 - i}-from-end`}
            ch={ch}
          />
        ))}
      </span>
    </span>
  )
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

function Char({ ch }: { ch: string }) {
  if (!/\d/.test(ch)) {
    return <span className="inline-block whitespace-pre">{ch}</span>
  }

  const digit = Number(ch)

  return (
    <span className="relative inline-block h-[1em] overflow-hidden align-bottom">
      {/*
        An invisible copy of the real character sizes the reel.

        Letting the ten-digit column size it instead made every place 8.59px
        against a true glyph advance of 6.97px — 1.6px of padding per digit,
        which is what turned "5.100" into a visibly gappy "5.1 00". Measuring
        from the actual character makes the reel identical to plain text by
        construction, whatever the font does.
      */}
      <span className="invisible" aria-hidden>
        {ch}
      </span>
      <span
        className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-500 ease-[var(--ease-brand)] will-change-transform"
        style={{ transform: `translateY(-${digit}em)` }}
      >
        {DIGITS.map((d) => (
          <span key={d} className="h-[1em]">
            {d}
          </span>
        ))}
      </span>
    </span>
  )
}
