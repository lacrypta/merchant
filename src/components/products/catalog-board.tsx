"use client"

import * as React from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
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
  Eye,
  EyeOff,
  GripVertical,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"

import { useCatalog } from "@/components/catalog/catalog-provider"
import { ChangeBadge } from "@/components/catalog/change-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatAmount, formatPrice } from "@/lib/domain/price"
import type { Category } from "@/lib/domain/category"
import type { Product, Visibility } from "@/lib/domain/product"
import { cn } from "@/lib/utils"

export interface Group {
  /** null = the "Sin categoría" bucket. */
  category: Category | null
  products: Product[]
}

/** Stable container key for a group. */
const LOOSE = "__uncategorised"
const keyOf = (g: Group) => g.category?.d ?? LOOSE
/** Droppable id for a container. Prefixed so it can never collide with a uuid. */
const zoneOf = (key: string) => `zone:${key}`

/**
 * The catalog board: categories as sections, products nested inside.
 *
 * Standard dnd-kit multi-container setup. Three gestures, one DndContext:
 *  - drag a category   -> reorder categories, rewrites each `order` tag
 *  - drag a product    -> reorder inside its group, rewrites the `a` list
 *  - drop it elsewhere -> reparent, rewrites the product's `t` tags
 *
 * Two mistakes that cost real debugging time and are worth not repeating:
 *
 * 1. A second `useDroppable` was registered on the SAME <section> node that
 *    `useSortable` already owns. useSortable is itself a draggable + droppable,
 *    so two registrations fought over one element and drags cancelled on
 *    pickup. The container droppable now lives on the inner <ul>, a node
 *    nothing else claims.
 *
 * 2. Nesting a second DndContext for products: the outer context captured the
 *    keyboard sensor and only knew category ids, so lifting a product
 *    announced it as dropped on itself.
 *
 * `containers` is local state so a row visibly follows the cursor across
 * section boundaries during the gesture; it re-syncs from props whenever the
 * catalog changes and no drag is in progress.
 */
export function CatalogBoard({
  groups,
  onEditCategory,
  onDeleteCategory,
  onDeleteProduct,
  onEditProduct,
  onCreateProduct,
  onMoveProduct,
  onToggleProductVisibility,
  onEditProductPrice,
  onReorderCategories,
  onReorderProducts,
}: {
  groups: Group[]
  onEditProduct: (p: Product) => void
  /** Create a product already assigned to this category (null = loose). */
  onCreateProduct: (slug: string | null) => void
  onEditCategory: (c: Category) => void
  onDeleteCategory: (c: Category) => void
  onDeleteProduct: (p: Product) => void
  onMoveProduct: (p: Product, toSlug: string | null) => void
  onToggleProductVisibility: (p: Product, next: Visibility) => void
  onEditProductPrice: (next: Product) => void
  onReorderCategories: (orderedDs: string[]) => void
  onReorderProducts: (category: Category, orderedDs: string[]) => void
}) {
  const { categories, pending } = useCatalog()

  const [activeId, setActiveId] = React.useState<string | null>(null)
  /** containerKey -> ordered product d-tags */
  const [containers, setContainers] = React.useState<Record<string, string[]>>(
    () => Object.fromEntries(groups.map((g) => [keyOf(g), g.products.map((p) => p.d)]))
  )
  /** Where the dragged product started, so we know if it actually moved. */
  const originRef = React.useRef<string | null>(null)

  const fromProps = React.useMemo(
    () => Object.fromEntries(groups.map((g) => [keyOf(g), g.products.map((p) => p.d)])),
    [groups]
  )

  /**
   * Re-sync from props, but never mid-gesture — that would yank the row back
   * under the cursor.
   *
   * Adjusted DURING RENDER rather than in an effect. This is React's
   * documented pattern for state derived from props: an effect would paint
   * the stale list first and then cascade a second render.
   */
  const [syncedFrom, setSyncedFrom] = React.useState(fromProps)
  if (!activeId && syncedFrom !== fromProps) {
    setSyncedFrom(fromProps)
    setContainers(fromProps)
  }

  const productById = React.useMemo(() => {
    const m = new Map<string, Product>()
    for (const g of groups) for (const p of g.products) m.set(p.d, p)
    return m
  }, [groups])

  const groupByKey = React.useMemo(() => {
    const m = new Map<string, Group>()
    for (const g of groups) m.set(keyOf(g), g)
    return m
  }, [groups])

  const categoryIds = groups.filter((g) => g.category).map((g) => g.category!.d)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // The delay is what keeps a scroll gesture from becoming a drag on touch.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  /**
   * Prefer whatever is directly under the pointer; fall back to rect overlap
   * and then to corner distance. Plain closestCenter picks the section the
   * pointer has already left when lists have very different heights.
   */
  const collisionDetection: CollisionDetection = React.useCallback((args) => {
    const pointer = pointerWithin(args)
    if (pointer.length > 0) return pointer
    const intersections = rectIntersection(args)
    if (intersections.length > 0) return intersections
    return closestCorners(args)
  }, [])

  /** Which container currently holds this id (or is this id a container?). */
  function findContainer(id: string): string | undefined {
    if (id.startsWith("zone:")) return id.slice(5)
    if (containers[id]) return id
    return Object.keys(containers).find((k) => containers[k]!.includes(id))
  }

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id)
    setActiveId(id)
    originRef.current = categoryIds.includes(id) ? null : (findContainer(id) ?? null)
  }

  /** Move the row between containers live, so the drop target is obvious. */
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e
    if (!over) return
    const activeKey = String(active.id)
    if (categoryIds.includes(activeKey)) return // categories don't reparent

    const from = findContainer(activeKey)
    const to = findContainer(String(over.id))
    if (!from || !to || from === to) return

    setContainers((prev) => {
      const source = prev[from] ?? []
      const target = prev[to] ?? []
      if (!source.includes(activeKey)) return prev

      const overId = String(over.id)
      const overIndex = target.indexOf(overId)
      const insertAt = overIndex >= 0 ? overIndex : target.length

      return {
        ...prev,
        [from]: source.filter((x) => x !== activeKey),
        [to]: [...target.slice(0, insertAt), activeKey, ...target.slice(insertAt)],
      }
    })
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    const activeKey = String(active.id)
    const origin = originRef.current
    setActiveId(null)
    originRef.current = null

    if (!over) return

    // 1. Category reorder.
    if (categoryIds.includes(activeKey)) {
      const overKey = String(over.id)
      const from = categoryIds.indexOf(activeKey)
      const to = categoryIds.indexOf(overKey)
      if (from < 0 || to < 0 || from === to) return
      onReorderCategories(arrayMove(categoryIds, from, to))
      return
    }

    const target = findContainer(String(over.id))
    if (!target || !origin) return

    const product = productById.get(activeKey)
    if (!product) return

    // 2. Reparented into another category.
    if (target !== origin) {
      const group = groupByKey.get(target)
      onMoveProduct(product, group?.category?.slug ?? null)
      return
    }

    // 3. Same container — commit the new order, if it changed.
    const group = groupByKey.get(target)
    if (!group?.category) return // the loose bucket has no order to persist

    const current = containers[target] ?? []
    const overIndex = current.indexOf(String(over.id))
    const activeIndex = current.indexOf(activeKey)
    if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return

    onReorderProducts(group.category, arrayMove(current, activeIndex, overIndex))
  }

  const draggingProduct = activeId ? productById.get(activeId) : undefined
  const draggingCategory = activeId
    ? groups.find((g) => g.category?.d === activeId)?.category
    : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragCancel={() => {
        setActiveId(null)
        originRef.current = null
        setContainers(fromProps)
      }}
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
          {groups.map((group) => {
            const key = keyOf(group)
            const ids = containers[key] ?? []
            return (
              <CategorySection
                key={key}
                group={group}
                containerKey={key}
                productIds={ids}
                productById={productById}
                allCategories={categories}
                busy={group.category ? pending.has(group.category.d) : false}
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onDeleteProduct={onDeleteProduct}
                onEditProduct={onEditProduct}
                onCreateProduct={onCreateProduct}
                onMoveProduct={onMoveProduct}
                onToggleProductVisibility={onToggleProductVisibility}
                onEditProductPrice={onEditProductPrice}
              />
            )
          })}
        </div>
      </SortableContext>

      {/* The travelling copy. Without it the row stays clipped inside its
          original list and cannot be seen crossing into another section. */}
      <DragOverlay dropAnimation={null}>
        {draggingProduct ? (
          <div className="flex items-center gap-3 rounded-xl border border-primary/50 bg-card p-3 shadow-2xl">
            <GripVertical className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{draggingProduct.title}</span>
            {draggingProduct.price ? (
              <span className="numeric ml-auto font-semibold text-primary">
                {formatPrice(
                  draggingProduct.price.amount,
                  draggingProduct.price.currency
                )}
              </span>
            ) : null}
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
  if (key.startsWith("zone:")) {
    const g = groups.find((x) => keyOf(x) === key.slice(5))
    return g?.category ? `la categoría ${g.category.name}` : "Sin categoría"
  }
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
  containerKey,
  productIds,
  productById,
  allCategories,
  busy,
  onEditCategory,
  onDeleteCategory,
  onDeleteProduct,
  onEditProduct,
  onCreateProduct,
  onMoveProduct,
  onToggleProductVisibility,
  onEditProductPrice,
}: {
  group: Group
  containerKey: string
  productIds: string[]
  productById: Map<string, Product>
  allCategories: Category[]
  busy: boolean
  onEditCategory: (c: Category) => void
  onDeleteCategory: (c: Category) => void
  onDeleteProduct: (p: Product) => void
  onEditProduct: (p: Product) => void
  onCreateProduct: (slug: string | null) => void
  onMoveProduct: (p: Product, toSlug: string | null) => void
  onToggleProductVisibility: (p: Product, next: Visibility) => void
  onEditProductPrice: (next: Product) => void
}) {
  const category = group.category
  const { changes } = useCatalog()

  // The SECTION is the sortable (categories reorder). Nothing else may claim
  // this node — see the note at the top of the file.
  const sortable = useSortable({
    id: category?.d ?? LOOSE,
    disabled: !category,
  })

  // The LIST is the container droppable, on a separate node.
  const drop = useDroppable({ id: zoneOf(containerKey) })

  return (
    <section
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "rounded-2xl border bg-surface-2/40 p-3 transition-colors sm:p-4",
        drop.isOver ? "border-primary bg-primary/5" : "border-border",
        sortable.isDragging && "opacity-40",
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
            {productIds.length}
          </span>
        </h2>

        {category ? (
          <ChangeBadge kind={changes.categories.get(category.d)} />
        ) : null}

        {/* Present on every group, including the loose bucket: adding a
            product to the section you are already looking at should not
            require the toolbar and then picking the category again. */}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => onCreateProduct(category?.slug ?? null)}
        >
          <Plus className="size-4" aria-hidden />
          <span className="hidden sm:inline">Agregar producto</span>
          <span className="sr-only sm:hidden">
            Agregar producto a {category?.name ?? "Sin categoría"}
          </span>
        </Button>

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

      <SortableContext items={productIds} strategy={verticalListSortingStrategy}>
        <ul
          ref={drop.setNodeRef}
          // min-height keeps an empty group a real drop target instead of a
          // zero-height line the pointer can never land on.
          className={cn(
            "space-y-2 rounded-lg",
            productIds.length === 0 &&
              "grid min-h-20 place-items-center border border-dashed px-3 text-sm transition-colors",
            productIds.length === 0 &&
              (drop.isOver
                ? "border-primary text-primary"
                : "border-border text-muted-foreground")
          )}
        >
          {productIds.length === 0 ? (
            <li className="flex list-none flex-wrap items-center justify-center gap-x-1.5 gap-y-2 py-1">
              {drop.isOver ? (
                "Soltá acá"
              ) : (
                <>
                  <span>Vacía. Arrastrá un producto acá</span>
                  <span aria-hidden>o</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onCreateProduct(category?.slug ?? null)}
                  >
                    <Plus className="size-4" aria-hidden />
                    Crear uno
                  </Button>
                </>
              )}
            </li>
          ) : (
            productIds.map((id) => {
              const product = productById.get(id)
              if (!product) return null
              return (
                <ProductRow
                  key={id}
                  product={product}
                  categories={allCategories}
                  currentSlug={category?.slug ?? null}
                  onDelete={() => onDeleteProduct(product)}
                  onEdit={() => onEditProduct(product)}
                  onMove={(slug) => onMoveProduct(product, slug)}
                  onToggleVisibility={(next) =>
                    onToggleProductVisibility(product, next)
                  }
                  onEditPrice={onEditProductPrice}
                />
              )
            })
          )}
        </ul>
      </SortableContext>
    </section>
  )
}

function ProductRow({
  product,
  categories,
  currentSlug,
  onDelete,
  onEdit,
  onMove,
  onToggleVisibility,
  onEditPrice,
}: {
  product: Product
  categories: Category[]
  currentSlug: string | null
  onDelete: () => void
  onEdit: () => void
  onMove: (slug: string | null) => void
  onToggleVisibility: (next: Visibility) => void
  onEditPrice: (next: Product) => void
}) {
  const { pending, changes } = useCatalog()
  const busy = pending.has(product.d)
  const s = useSortable({ id: product.d, disabled: busy })
  const thumb = product.images[0]
  const hidden = product.visibility === "hidden"
  /** What it was before being hidden, so unhiding restores "pre-venta". */
  const wasVisible = React.useRef<Visibility | null>(null)

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
        busy && "opacity-60",
        // A hidden product is still in the catalog and still editable — it is
        // just not in the shop. Dimming reads as "inactive" at a glance
        // without pushing it out of reach.
        hidden && "opacity-55"
      )}
    >
      <button
        type="button"
        className="tap-44 shrink-0 cursor-grab text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
        aria-label={`Reordenar ${product.title}`}
        disabled={busy}
        {...s.attributes}
        {...s.listeners}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>

      <div
        className={cn(
          "size-12 shrink-0 overflow-hidden rounded-lg bg-surface-3",
          hidden && "grayscale"
        )}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb.url} alt="" className="size-full object-cover" />
        ) : (
          <div aria-hidden className="grid-flat size-full opacity-40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* A real <button>, not a clickable <div>: it has to be reachable by
              keyboard and announced as an action. Only the NAME opens the
              editor — making the whole row clickable would fight the drag
              handle and the overflow menu that live in it. */}
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="truncate rounded-sm text-left font-semibold hover:text-primary hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none"
          >
            <span className={cn(hidden && "line-through decoration-1")}>
              {product.title}
            </span>
          </button>
          <ChangeBadge kind={changes.products.get(product.d)} />
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

      <PriceCell
        product={product}
        dimmed={hidden}
        disabled={busy}
        onCommit={(amount) =>
          onEditPrice({
            ...product,
            price: { amount, currency: product.price?.currency ?? "ARS" },
          })
        }
      />

      <Button
        variant="ghost"
        size="icon-sm"
        className="tap-44 shrink-0"
        disabled={busy}
        aria-pressed={hidden}
        aria-label={
          hidden ? `Mostrar ${product.title}` : `Ocultar ${product.title}`
        }
        title={hidden ? "Mostrar en la tienda" : "Ocultar de la tienda"}
        onClick={() => {
          if (hidden) {
            // Put back whatever it was before it was hidden, when we saw it
            // happen — otherwise the spec default. Without this, hiding and
            // unhiding a pre-venta product would silently demote it.
            onToggleVisibility(wasVisible.current ?? "on-sale")
          } else {
            wasVisible.current = product.visibility
            onToggleVisibility("hidden")
          }
        }}
      >
        {hidden ? (
          <EyeOff className="size-4 text-warning" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </Button>

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
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" aria-hidden />
            Editar
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

/**
 * The price, editable where it is shown.
 *
 * Changing a price is the single most common edit a merchant makes — a supplier
 * moves, the peso moves — and routing it through the full product dialog for a
 * three-digit change was the slowest fast thing in the app.
 *
 * The currency is deliberately NOT editable here: it changes what the number
 * means, and switching it by accident while retyping an amount would mis-price
 * the product silently. That stays in the form.
 */
function PriceCell({
  product,
  dimmed,
  disabled,
  onCommit,
}: {
  product: Product
  dimmed: boolean
  disabled: boolean
  onCommit: (amount: number) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState("")
  const currency = product.price?.currency ?? "ARS"

  function open() {
    setValue(product.price ? formatAmount(product.price) : "")
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    // Commas are how half the world types decimals, and the numeric keypad on
    // an es-AR phone offers one.
    const amount = Number(value.replace(",", "."))
    if (!Number.isFinite(amount) || amount <= 0) return
    // Sub-sat prices cannot be charged; rounding silently would mis-price it.
    if (currency === "SAT" && !Number.isInteger(amount)) return
    if (product.price && amount === product.price.amount) return
    onCommit(amount)
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={open}
        title="Cambiar el precio"
        aria-label={`Cambiar el precio de ${product.title}`}
        className={cn(
          "numeric shrink-0 rounded-md px-1 font-semibold transition-colors",
          "hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:pointer-events-none",
          dimmed ? "text-muted-foreground line-through decoration-1" : "text-primary"
        )}
      >
        {product.price
          ? formatPrice(product.price.amount, product.price.currency)
          : "—"}
      </button>
    )
  }

  /**
   * Editing looks like reading, plus a box.
   *
   * Same size, weight and colour as the price it replaces — including the
   * currency, which the display renders as part of the same string. A smaller,
   * white number in a grey-labelled box was a different piece of text
   * appearing where the price used to be, and the row jumped when it did.
   */
  const tone = dimmed ? "text-muted-foreground" : "text-primary"

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className={cn("numeric font-semibold", tone)}>{currency}</span>
      <input
        autoFocus
        type="text"
        inputMode="decimal"
        value={value}
        aria-label={`Precio de ${product.title} en ${currency}`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
          if (e.key === "Escape") {
            e.preventDefault()
            setEditing(false)
          }
          // The row is a drag handle and a dnd-kit sortable; without this,
          // arrows and space reach the sortable instead of the caret.
          e.stopPropagation()
        }}
        className={cn(
          "numeric h-8 w-24 rounded-md border border-border-strong bg-transparent px-2 text-right font-semibold",
          "focus-visible:border-primary focus-visible:outline-none",
          tone
        )}
      />
    </span>
  )
}
