"use client"

import * as React from "react"
import Link from "next/link"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  GripVertical,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatPrice } from "@/lib/domain/price"
import type { Category } from "@/lib/domain/category"
import type { Product } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

export interface Group {
  /** null = the "Sin categoría" bucket, which is never draggable. */
  category: Category | null
  products: Product[]
}

/**
 * The catalog board: categories as sections, products nested inside.
 *
 * ONE DndContext drives three kinds of drag, routed by what was picked up:
 *  - a category reorders among categories  -> rewrites each `order` tag
 *  - a product reorders inside its group   -> rewrites that category's `a` list
 *  - a product dropped on another group    -> rewrites the product's `t` tags
 *
 * Nesting a second DndContext for products was tried and is broken: the outer
 * context captures the keyboard sensor and only knows category ids, so lifting
 * a product announced it as dropped on itself.
 *
 * Empty categories are explicit droppables — otherwise there is no row to
 * collide with and a product could never be dragged into an empty group.
 */
export function CatalogBoard({
  groups,
  onEditCategory,
  onDeleteCategory,
  onDeleteProduct,
  onMoveProduct,
  onReorderCategories,
  onReorderProducts,
}: {
  groups: Group[]
  onEditCategory: (c: Category) => void
  onDeleteCategory: (c: Category) => void
  onDeleteProduct: (p: Product) => void
  onMoveProduct: (p: Product, toSlug: string | null) => void
  onReorderCategories: (orderedDs: string[]) => void
  onReorderProducts: (category: Category, orderedDs: string[]) => void
}) {
  const { categories, pending } = useCatalog()
  const [draggingId, setDraggingId] = React.useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // The delay is what keeps a scroll gesture from becoming a drag on touch.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const categoryIds = groups
    .filter((g) => g.category)
    .map((g) => g.category!.d)

  /** Droppable id for a whole section, used when the group is empty. */
  const zoneId = (g: Group) => `zone:${g.category?.d ?? "__uncategorised"}`

  /** Which group does this draggable/droppable id belong to? */
  function groupOf(id: string): Group | undefined {
    if (id.startsWith("zone:")) {
      const key = id.slice(5)
      return groups.find((g) => (g.category?.d ?? "__uncategorised") === key)
    }
    const byCategory = groups.find((g) => g.category?.d === id)
    if (byCategory) return byCategory
    return groups.find((g) => g.products.some((p) => p.d === id))
  }

  /**
   * ONE DndContext for the whole board.
   *
   * Nesting a product DndContext inside a category one looked tidier but was
   * broken: the outer context captured the keyboard sensor and only knew
   * category ids, so lifting a product announced it as dropped on itself and
   * never moved. A single context with per-list SortableContexts keeps the
   * two axes independent while letting one handler route the drag.
   */
  function handleDragEnd(e: DragEndEvent) {
    setDraggingId(null)
    const { active, over } = e
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    // 1. Category reorder.
    if (categoryIds.includes(activeId)) {
      const from = categoryIds.indexOf(activeId)
      const to = categoryIds.indexOf(overId)
      if (from < 0 || to < 0) return
      onReorderCategories(arrayMove(categoryIds, from, to))
      return
    }

    const source = groups.find((g) => g.products.some((p) => p.d === activeId))
    if (!source) return
    const target = groupOf(overId)
    if (!target) return

    // 2. Same group -> reorder within it.
    if (target === source) {
      if (!source.category) return // the "Sin categoría" bucket has no order
      const ids = source.products.map((p) => p.d)
      const from = ids.indexOf(activeId)
      const to = ids.indexOf(overId)
      if (from < 0 || to < 0) return
      onReorderProducts(source.category, arrayMove(ids, from, to))
      return
    }

    // 3. Different group -> reparent. One signature: only the product's own
    // `t` tags change, because `t` is authoritative for membership. The
    // category `a` lists are ordering hints and get repaired on the next save.
    const product = source.products.find((p) => p.d === activeId)
    if (product) onMoveProduct(product, target.category?.slug ?? null)
  }

  const draggingProduct = draggingId
    ? groups.flatMap((g) => g.products).find((p) => p.d === draggingId)
    : undefined
  const draggingCategory = draggingId
    ? groups.find((g) => g.category?.d === draggingId)?.category
    : undefined


  return (
    <DndContext
      sensors={sensors}
      // closestCorners, not closestCenter: with nested lists of differing
      // heights, centre-distance frequently picks the section the pointer has
      // already left. No axis modifier either — dragging between groups is a
      // two-dimensional gesture.
      collisionDetection={closestCorners}
      onDragStart={(e: DragStartEvent) => setDraggingId(String(e.active.id))}
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Levantaste ${labelOf(active.id, groups)}.`,
          onDragOver: ({ over }) =>
            over ? `Sobre ${labelOf(over.id, groups)}.` : "",
          onDragEnd: ({ over }) =>
            over ? `Soltaste sobre ${labelOf(over.id, groups)}.` : "Cancelado.",
          onDragCancel: () => "Cancelaste el movimiento.",
        },
      }}
    >
      <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-8">
          {groups.map((group) => (
            <CategorySection
              key={group.category?.d ?? "__uncategorised"}
              group={group}
              allCategories={categories}
              busy={group.category ? pending.has(group.category.d) : false}
              onEditCategory={onEditCategory}
              onDeleteCategory={onDeleteCategory}
              onDeleteProduct={onDeleteProduct}
              onMoveProduct={onMoveProduct}
              zoneId={zoneId(group)}
            />
          ))}
        </div>
      </SortableContext>

      {/* Overlay follows the cursor across section boundaries; without it the
          row stays clipped inside its original list while dragging out. */}
      <DragOverlay dropAnimation={null}>
        {draggingProduct ? (
          <div className="flex items-center gap-3 rounded-xl border border-primary/50 bg-card p-3 shadow-2xl">
            <GripVertical className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{draggingProduct.title}</span>
          </div>
        ) : draggingCategory ? (
          <div className="rounded-2xl border border-primary/50 bg-surface-2 px-4 py-3 shadow-2xl">
            <span className="text-h3">
              {draggingCategory.emoji ? `${draggingCategory.emoji} ` : ""}
              {draggingCategory.name}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function labelOf(id: string | number, groups: Group[]): string {
  const key = String(id)
  const category = groups.find((g) => g.category?.d === key)?.category
  if (category) return `la categoría ${category.name}`
  for (const g of groups) {
    const p = g.products.find((x) => x.d === key)
    if (p) return p.title
  }
  return "el elemento"
}

function CategorySection({
  group,
  allCategories,
  busy,
  onEditCategory,
  onDeleteCategory,
  onDeleteProduct,
  onMoveProduct,
  zoneId,
}: {
  group: Group
  allCategories: Category[]
  busy: boolean
  zoneId: string
  onEditCategory: (c: Category) => void
  onDeleteCategory: (c: Category) => void
  onDeleteProduct: (p: Product) => void
  onMoveProduct: (p: Product, toSlug: string | null) => void
}) {
  const category = group.category
  const sortable = useSortable({
    id: category?.d ?? "__uncategorised",
    disabled: !category,
  })

  const style = category
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }
    : undefined

  const productIds = group.products.map((p) => p.d)

  // A section-wide droppable so a product can be dropped into a group that has
  // no rows to collide with. `isOver` also gives the whole section a target
  // highlight, which is the only affordance telling you the drop will land.
  const drop = useDroppable({ id: zoneId })

  /**
   * The section is BOTH a sortable (categories reorder) and a droppable
   * (products land in it), so two refs share one node.
   *
   * This MUST be memoised. An inline arrow is a new function every render, so
   * React detaches it with null and re-attaches on each re-render — and since
   * drag start sets state, dnd-kit saw its draggable node vanish mid-gesture
   * and cancelled the drag immediately. dnd-kit's setNodeRef identities are
   * stable, so this callback is created once.
   */
  const setSectionRef = React.useCallback(
    (node: HTMLElement | null) => {
      if (category) sortable.setNodeRef(node)
      drop.setNodeRef(node)
    },
    [category, sortable.setNodeRef, drop.setNodeRef]
  )

  return (
    <section
      ref={setSectionRef}
      style={style}
      className={cn(
        "rounded-2xl border bg-surface-2/40 p-3 transition-colors sm:p-4",
        drop.isOver ? "border-primary bg-primary/5" : "border-border",
        sortable.isDragging && "z-10 opacity-80 shadow-2xl",
        busy && "opacity-60"
      )}
    >
      <header className="mb-3 flex items-center gap-2">
        {category ? (
          <button
            type="button"
            className="tap-44 cursor-grab text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
            aria-label={`Reordenar ${category.name}`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        ) : (
          <span className="size-4" aria-hidden />
        )}

        <h2 className="text-h3 min-w-0 flex-1 truncate">
          {category?.emoji ? (
            <span aria-hidden className="mr-2">
              {category.emoji}
            </span>
          ) : null}
          {category?.name ?? "Sin categoría"}
          <span className="numeric ml-2 text-sm font-medium text-muted-foreground">
            {group.products.length}
          </span>
        </h2>

        {category ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="tap-44"
                aria-label={`Acciones para ${category.name}`}
                disabled={busy}
              >
                <MoreVertical className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onEditCategory(category)}>
                <Pencil className="size-4" aria-hidden />
                Editar categoría
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onDeleteCategory(category)}
                className="text-danger"
              >
                <Trash2 className="size-4" aria-hidden />
                Eliminar categoría
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {group.products.length === 0 ? (
        <p
          className={cn(
            "rounded-lg border border-dashed px-3 py-6 text-center text-sm transition-colors",
            drop.isOver
              ? "border-primary text-primary"
              : "border-border text-muted-foreground"
          )}
        >
          {drop.isOver ? "Soltá acá" : "Vacía. Arrastrá un producto acá."}
        </p>
      ) : (
        <SortableContext items={productIds} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2">
              {group.products.map((p) => (
                <ProductRow
                  key={p.d}
                  product={p}
                  categories={allCategories}
                  currentSlug={category?.slug ?? null}
                  sortable={!!category}
                  onDelete={() => onDeleteProduct(p)}
                  onMove={(slug) => onMoveProduct(p, slug)}
                />
              ))}
          </ul>
        </SortableContext>
      )}
    </section>
  )
}

function ProductRow({
  product,
  categories,
  currentSlug,
  sortable: canSort,
  onDelete,
  onMove,
}: {
  product: Product
  categories: Category[]
  currentSlug: string | null
  sortable: boolean
  onDelete: () => void
  onMove: (slug: string | null) => void
}) {
  const { pending } = useCatalog()
  const busy = pending.has(product.d)
  const s = useSortable({ id: product.d, disabled: !canSort || busy })
  const thumb = product.images[0]

  return (
    <li
      ref={s.setNodeRef}
      style={{
        transform: CSS.Transform.toString(s.transform),
        transition: s.transition,
      }}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-card p-3",
        // The DragOverlay renders the travelling copy; leaving the original
        // visible would show the row twice.
        s.isDragging && "opacity-0",
        busy && "opacity-60"
      )}
    >
      {canSort ? (
        <button
          type="button"
          className="tap-44 shrink-0 cursor-grab text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
          aria-label={`Reordenar ${product.title}`}
          {...s.attributes}
          {...s.listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}

      <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-surface-3">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb.url} alt="" className="size-full object-cover" />
        ) : (
          <div aria-hidden className="grid-flat size-full opacity-40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold">{product.title}</p>
          {product.lifecycle === "draft" ? (
            <Badge className="border-warning/30 bg-warning-bg text-warning">
              Borrador
            </Badge>
          ) : null}
          {product.visibility === "hidden" ? (
            <Badge variant="secondary">Oculto</Badge>
          ) : null}
          {product.stock !== null && product.stock <= 0 ? (
            <Badge className="border-danger/30 bg-danger-bg text-danger">
              Sin stock
            </Badge>
          ) : null}
        </div>
        {product.summary ? (
          <p className="truncate text-sm text-muted-foreground">
            {product.summary}
          </p>
        ) : null}
      </div>

      <p className="numeric shrink-0 font-semibold text-primary">
        {product.price
          ? formatPrice(product.price.amount, product.price.currency)
          : "—"}
      </p>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="tap-44 shrink-0"
            aria-label={`Acciones para ${product.title}`}
            disabled={busy}
          >
            <MoreVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem asChild>
            <Link href={`/products/${product.d}/edit`}>
              <Pencil className="size-4" aria-hidden />
              Editar
            </Link>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Mover a</p>
          {categories
            .filter((c) => c.slug !== currentSlug)
            .map((c) => (
              <DropdownMenuItem key={c.d} onSelect={() => onMove(c.slug)}>
                {c.emoji ? <span aria-hidden>{c.emoji}</span> : null}
                {c.name}
              </DropdownMenuItem>
            ))}
          {currentSlug ? (
            <DropdownMenuItem onSelect={() => onMove(null)}>
              Sin categoría
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete} className="text-danger">
            <Trash2 className="size-4" aria-hidden />
            Eliminar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function AddCategoryButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick}>
      <Plus className="size-4" aria-hidden />
      Nueva categoría
    </Button>
  )
}
