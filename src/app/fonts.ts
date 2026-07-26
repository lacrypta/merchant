import localFont from "next/font/local";

/**
 * Standerd — La Crypta's brand typeface.
 *
 * Source: github.com/lacrypta/branding (MIT, © Peronio.AR). The repo ships
 * .otf/.ttf only; these .woff2 files were produced with pyftsubset, subset to
 * Latin + es-AR punctuation, ~9KB each. See public/fonts/LICENSE-Standerd.txt.
 *
 * Only 400/500/600/700 are shipped — nothing in this design calls for Light,
 * Black or italics, and `font-synthesis-weight: none` in globals.css means a
 * stray font-black degrades to 700 rather than rendering a fake weight.
 *
 * NOTE: the font has NO glyph for ₿ (U+20BF). Never use it in UI copy —
 * write "sat" / "sats" instead, which matches the LaPOS convention anyway.
 */
export const standerd = localFont({
  src: [
    { path: "../../public/fonts/Standerd-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/Standerd-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/Standerd-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/Standerd-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-standerd",
  display: "swap",
  // Generates metric overrides against Arial → near-zero CLS during swap.
  adjustFontFallback: "Arial",
  preload: true,
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
});
