/** Combining diacritical marks, escaped rather than written literally. */
const COMBINING = /[̀-ͯ]/g

/**
 * Category slug. Used verbatim as the `t` tag on both the product and the
 * kind:30405 collection, which is what binds membership together — so it is
 * LOCKED after creation and must be perfectly stable for a given input.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING, "") // "Bebidas Frías" -> "Bebidas Frias"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

/**
 * Accent- and case-insensitive fold, for es-AR search.
 * "Fernet con Coca" matches "fernet", "FERNET", and "férnet".
 */
export function fold(input: string): string {
  return input.normalize("NFD").replace(COMBINING, "").toLowerCase().trim()
}
