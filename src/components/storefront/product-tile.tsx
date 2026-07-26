import { formatPrice } from "@/lib/domain/price"
import type { Product } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

export function ProductTile({ product }: { product: Product }) {
  const thumb =
    product.images.find((i) => i.width === 256) ?? product.images[0] ?? null
  const soldOut = product.stock !== null && product.stock <= 0

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-square bg-surface-3">
        {thumb ? (
          // Merchant images are arbitrary attacker-controlled URLs, so this
          // deliberately uses a plain <img> rather than next/image — no
          // remotePatterns allowlist can cover "any Blossom server".
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb.url}
            alt={product.title}
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="grid-flat size-full opacity-40"
            title="Sin imagen"
          />
        )}

        {product.visibility === "pre-order" ? (
          <span className="absolute top-2 left-2 rounded-full border border-warning/30 bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
            Pre-venta
          </span>
        ) : null}

        {soldOut ? (
          <div className="absolute inset-0 grid place-items-center bg-black/70 text-xs font-semibold tracking-wide uppercase">
            Sin stock
          </div>
        ) : null}
      </div>

      <div className="space-y-1 p-3">
        <h3 className="line-clamp-2 text-sm leading-tight font-semibold">
          {product.title}
        </h3>
        {product.summary ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {product.summary}
          </p>
        ) : null}
        {product.price ? (
          <p className={cn("numeric text-price text-primary")}>
            {formatPrice(product.price.amount, product.price.currency)}
          </p>
        ) : (
          <p className="text-price text-muted-foreground">Consultar precio</p>
        )}
      </div>
    </article>
  )
}
