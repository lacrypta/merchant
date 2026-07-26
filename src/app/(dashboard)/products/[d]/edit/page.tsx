import { ProductEditor } from "@/components/products/product-editor"

export const metadata = { title: "Editar producto" }

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ d: string }>
}) {
  // Next 16: params is a Promise. Awaited here, in the one RSC per route,
  // so the client screen only ever receives plain strings.
  const { d } = await params
  return <ProductEditor d={d} />
}
