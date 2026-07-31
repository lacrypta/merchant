import { ProductsNav } from "@/components/products/products-nav"

/**
 * The catalog gained a sibling: /products/events is the raw-event inspector,
 * and this pill row is the only way to move between the two.
 */
export default function ProductsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <ProductsNav />
      {children}
    </div>
  )
}
