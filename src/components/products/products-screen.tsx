"use client"

import * as React from "react"
import Link from "next/link"

import { useAuth } from "@/components/auth/auth-provider"
import { useCatalog } from "@/components/catalog/catalog-provider"
import { UnsavedBar } from "@/components/catalog/unsaved-bar"
import { CategoryDialog } from "@/components/categories/category-dialog"
import { ProductDialog } from "@/components/products/product-dialog"
import { DeleteCategoryDialog } from "@/components/categories/delete-category-dialog"
import { EmptyState } from "@/components/feedback/empty-state"
import {
  AddCategoryButton,
  CatalogBoard,
  type Group,
} from "@/components/products/catalog-board"
import { PageHeader } from "@/components/shell/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import type { Category } from "@/lib/domain/category"
import type { Product } from "@/lib/domain/product"
import { fold } from "@/lib/domain/slug"

type StatusFilter = "todos" | "activos" | "borradores"

export function ProductsScreen() {
  const { state } = useAuth()
  const {
    loading,
    products,
    categories,
    saveProduct,
    saveCategory,
    deleteProduct,
    deleteCategory,
  } = useCatalog()

  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<StatusFilter>("todos")
  const [editingCategory, setEditingCategory] = React.useState<Category | null>(
    null
  )
  const [creatingCategory, setCreatingCategory] = React.useState(false)
  const [categoryToDelete, setCategoryToDelete] = React.useState<Category | null>(
    null
  )
  const [productToDelete, setProductToDelete] = React.useState<Product | null>(
    null
  )
  // undefined = closed. null = create. Product = edit that one.
  const [productInDialog, setProductInDialog] = React.useState<
    Product | null | undefined
  >(undefined)
  /** Category preselected when creating from an empty group. */
  const [createInCategory, setCreateInCategory] = React.useState<string | null>(
    null
  )

  const visible = React.useMemo(() => {
    const q = fold(query)
    return products.filter((p) => {
      if (filter === "activos" && p.lifecycle !== "published") return false
      if (filter === "borradores" && p.lifecycle !== "draft") return false
      if (!q) return true
      return fold(p.title).includes(q) || fold(p.summary ?? "").includes(q)
    })
  }, [products, filter, query])

  /**
   * `t` is authoritative for MEMBERSHIP; the category's `a` list only supplies
   * the order within a group. Drift between the two therefore costs ordering,
   * never a product disappearing.
   */
  const groups: Group[] = React.useMemo(() => {
    const bySlug = new Map(categories.map((c) => [c.slug, c]))
    const buckets = new Map<string, Product[]>()
    const loose: Product[] = []

    for (const p of visible) {
      const primary = p.categories.find((s) => bySlug.has(s))
      if (primary) {
        const list = buckets.get(primary) ?? []
        list.push(p)
        buckets.set(primary, list)
      } else {
        loose.push(p)
      }
    }

    const out: Group[] = categories.map((c) => {
      const list = buckets.get(c.slug) ?? []
      const rank = new Map(c.productDs.map((d, i) => [d, i]))
      list.sort(
        (a, b) =>
          (rank.get(a.d) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.d) ?? Number.MAX_SAFE_INTEGER) ||
          a.title.localeCompare(b.title, "es-AR")
      )
      return { category: c, products: list }
    })

    if (loose.length > 0) {
      loose.sort((a, b) => a.title.localeCompare(b.title, "es-AR"))
      out.push({ category: null, products: loose })
    }
    return out
  }, [visible, categories])

  const actions = (
    <div className="flex flex-wrap gap-2">
      <AddCategoryButton onClick={() => setCreatingCategory(true)} />
      <Button
        onClick={() => {
          setCreateInCategory(null)
          setProductInDialog(null)
        }}
      >
        Nuevo producto
      </Button>
    </div>
  )

  /**
   * Move a product to another category.
   *
   * A real MOVE: the product leaves the group it was in. Prepending the new
   * slug and keeping the old one would leave the product still tagged with a
   * category it visibly left, and it would silently reappear there the moment
   * the new one was deleted.
   *
   * Belonging to several categories at once is still supported — that is what
   * the chips in the edit form are for. Dragging is unambiguous.
   */
  function handleMoveProduct(p: Product, toSlug: string | null) {
    const known = new Set(categories.map((c) => c.slug))
    // Preserve any tags that aren't categories we manage, so a third-party
    // client's topic tags survive the move.
    const foreign = p.categories.filter((s) => !known.has(s))
    saveProduct({
      ...p,
      categories: toSlug ? [toSlug, ...foreign] : foreign,
    })
  }

  function handleReorderCategories(orderedDs: string[]) {
    // `order` is our own tag; rewrite it to match the new positions.
    for (const [index, d] of orderedDs.entries()) {
      const c = categories.find((x) => x.d === d)
      if (c && c.order !== index) saveCategory({ ...c, order: index })
    }
  }

  function handleReorderProducts(category: Category, orderedDs: string[]) {
    saveCategory({ ...category, productDs: orderedDs })
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Catálogo" action={actions} />
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
      </>
    )
  }

  const nothingAtAll = products.length === 0 && categories.length === 0

  return (
    <>
      <PageHeader
        title="Catálogo"
        count={products.length}
        description="Categorías y productos. Los cambios quedan pendientes hasta que los publicás en nostr."
        action={actions}
      />

      <UnsavedBar />

      {nothingAtAll ? (
        <EmptyState
          title="Todavía no tenés nada publicado"
          description="Empezá por una categoría (Bebidas, Comida, Merch) o creá un producto suelto."
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button onClick={() => setCreatingCategory(true)}>
                Crear categoría
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setCreateInCategory(null)
                  setProductInDialog(null)
                }}
              >
                Crear producto
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar…"
              aria-label="Buscar productos"
              className="h-11 max-w-xs rounded-full"
            />
            <SegmentedControl
              aria-label="Filtrar por estado"
              value={filter}
              onValueChange={(v) => setFilter(v as StatusFilter)}
              options={[
                { value: "todos", label: "Todos" },
                { value: "activos", label: "Activos" },
                { value: "borradores", label: "Borradores" },
              ]}
            />
          </div>

          {visible.length === 0 && query ? (
            <EmptyState
              title={`Sin resultados para «${query}»`}
              action={
                <Button variant="ghost" onClick={() => setQuery("")}>
                  Limpiar búsqueda
                </Button>
              }
            />
          ) : (
            <CatalogBoard
              groups={groups}
              onEditProduct={(p) => {
                setCreateInCategory(null)
                setProductInDialog(p)
              }}
              onCreateProduct={(slug) => {
                setCreateInCategory(slug)
                setProductInDialog(null)
              }}
              onEditCategory={setEditingCategory}
              onDeleteCategory={setCategoryToDelete}
              onDeleteProduct={setProductToDelete}
              onMoveProduct={handleMoveProduct}
              onReorderCategories={handleReorderCategories}
              onReorderProducts={handleReorderProducts}
            />
          )}
        </>
      )}

      <ProductDialog
        open={productInDialog !== undefined}
        existing={productInDialog ?? undefined}
        defaultCategory={createInCategory}
        onOpenChange={(o) => !o && setProductInDialog(undefined)}
      />

      <CategoryDialog
        open={creatingCategory || editingCategory !== null}
        existing={editingCategory}
        nextOrder={categories.length}
        onOpenChange={(o) => {
          if (!o) {
            setCreatingCategory(false)
            setEditingCategory(null)
          }
        }}
        onSave={(c) => {
          saveCategory(c)
          setCreatingCategory(false)
          setEditingCategory(null)
        }}
      />

      <DeleteCategoryDialog
        category={categoryToDelete}
        memberCount={
          categoryToDelete
            ? products.filter((p) => p.categories.includes(categoryToDelete.slug))
                .length
            : 0
        }
        onOpenChange={(o) => !o && setCategoryToDelete(null)}
        onConfirm={(mode) => {
          const c = categoryToDelete
          setCategoryToDelete(null)
          if (c) deleteCategory(c, mode)
        }}
      />

      <AlertDialog
        open={productToDelete !== null}
        onOpenChange={(o) => !o && setProductToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿Eliminar «{productToDelete?.title}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Queda pendiente hasta que guardes. Al publicar mandamos un pedido
              de borrado (NIP-09) y dejamos una lápida en su lugar: 2 firmas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const p = productToDelete
                setProductToDelete(null)
                if (p) deleteProduct(p)
              }}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {state.status === "ready" ? (
        <p className="mt-12 text-sm text-muted-foreground">
          Tu tienda pública:{" "}
          <Link
            href={`/s/${state.npub}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            /s/{state.npub.slice(0, 12)}…
          </Link>
        </p>
      ) : null}
    </>
  )
}
