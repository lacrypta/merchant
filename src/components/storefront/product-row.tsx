import { formatPrice } from "@/lib/domain/price"
import type { Product } from "@/lib/domain/product"

/**
 * One product, as a row in a menu.
 *
 * A list rather than a grid of big square tiles: a bar menu is read by
 * scanning names and prices down a column, not by browsing photographs. The
 * thumbnail earns a fixed 56px and nothing more, so twice as many items fit
 * on a phone screen and the price column stays aligned all the way down.
 */
export function ProductRow({
  product,
  showImage,
  action,
}: {
  product: Product
  /**
   * Whether this storefront reserves space for images AT ALL.
   *
   * Decided once for the whole catalog by the page, not per product: a
   * per-row decision would leave a ragged left edge wherever one item happens
   * to have a photo and its neighbour does not. When no product anywhere has
   * an image, the column disappears entirely and the menu closes up.
   */
  showImage: boolean
  /**
   * The add-to-cart control. A slot rather than props so this stays a Server
   * Component: only the six fields the control needs cross the wire, instead
   * of the whole Product with its markdown description and unknown tags.
   */
  action?: React.ReactNode
}) {
  const thumb =
    product.images.find((i) => i.width === 256) ?? product.images[0] ?? null
  const soldOut = product.stock !== null && product.stock <= 0

  return (
    <article className="group enter-row flex items-center gap-3 px-3 py-2.5 transition-colors duration-200 hover:bg-surface-2 sm:gap-4 sm:px-4">
      {showImage ? (
        <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-surface-3 transition-transform duration-200 motion-safe:group-hover:scale-105">
          {thumb ? (
            // Merchant images are arbitrary attacker-controlled URLs, so this
            // deliberately uses a plain <img> rather than next/image — no
            // remotePatterns allowlist can cover "any Blossom server".
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumb.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover"
            />
          ) : (
            <div aria-hidden className="grid-flat size-full opacity-40" />
          )}
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-x-2 text-sm leading-tight font-semibold">
          <span className="min-w-0 break-words">{product.title}</span>
          {product.visibility === "pre-order" ? (
            <span className="shrink-0 rounded-full border border-warning/30 bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
              Pre-venta
            </span>
          ) : null}
          {soldOut ? (
            <span className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Sin stock
            </span>
          ) : null}
        </h3>
        {product.summary ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {product.summary}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {product.price ? (
          <p className="numeric text-right text-sm font-semibold text-primary sm:text-base">
            {formatPrice(product.price.amount, product.price.currency)}
          </p>
        ) : (
          <p className="text-right text-xs text-muted-foreground">
            Consultar
            <br />
            precio
          </p>
        )}

        {/* Only when it can actually be bought. The sold-out predicate is
            computed here, so gating the slot here is what stops a second copy
            of that rule drifting out of sync in the caller. */}
        {soldOut ? null : action}
      </div>
    </article>
  )
}
