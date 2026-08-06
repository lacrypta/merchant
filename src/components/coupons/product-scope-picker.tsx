"use client"

import { Check, ChevronsUpDown, Store, X } from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Which products a discount applies to — none picked means all of them.
 *
 * That default is the whole design. A merchant offering "10% off" means the
 * store, and a picker that forced them to tick every product to say so would
 * be worse than no picker. So the empty state is not "choose something", it is
 * an answer: "Todos los productos".
 *
 * Searchable rather than a plain list because a catalog runs to hundreds of
 * items, and a coupon usually names two or three of them.
 */
export interface ScopeProduct {
  d: string
  title: string
}

export function ProductScopePicker({
  value,
  onChange,
  products,
  /** What "no products picked" means here, in words. */
  allLabel = "Todos los productos",
  /**
   * False for a picker whose empty state is not an answer.
   *
   * "Producto gratis" is the one benefit that cannot mean the whole catalog —
   * so there is no "todos" row to pick, and the trigger asks for products
   * instead of claiming to have them all.
   */
  emptyMeansAll = true,
  /** False when the caller lists what was picked itself — with quantities. */
  showSelected = true,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  products: ScopeProduct[]
  allLabel?: string
  emptyMeansAll?: boolean
  showSelected?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)

  const toggle = (d: string) =>
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d])

  const selected = value
    .map((d) => products.find((p) => p.d === d) ?? { d, title: "Producto borrado" })
    // Keep the merchant's own order rather than the catalog's: they picked
    // these one at a time and the list should not reshuffle underneath them.
    .filter(Boolean)

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || products.length === 0}
            className="h-12 w-full justify-between px-4 text-base font-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              {value.length === 0 ? (
                <>
                  {emptyMeansAll ? (
                    <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : null}
                  <span className={cn(!emptyMeansAll && "text-muted-foreground")}>
                    {allLabel}
                  </span>
                </>
              ) : (
                <span className="truncate">
                  {value.length === 1
                    ? selected[0]!.title
                    : `${value.length} productos elegidos`}
                </span>
              )}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[min(28rem,90vw)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar producto…" />
            <CommandList>
              <CommandEmpty>No encontramos ese producto.</CommandEmpty>
              {emptyMeansAll ? (
                <CommandGroup>
                  <CommandItem
                    value="__todos__"
                    onSelect={() => {
                      onChange([])
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn("size-4", value.length > 0 && "opacity-0")}
                      aria-hidden
                    />
                    <span className="font-medium">{allLabel}</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}

              <CommandGroup heading={emptyMeansAll ? "Solo estos" : undefined}>
                {products.map((p) => (
                  <CommandItem
                    key={p.d}
                    // Searched by title, not by uuid — nobody types a uuid.
                    value={p.title}
                    onSelect={() => toggle(p.d)}
                  >
                    <Check
                      className={cn("size-4", !value.includes(p.d) && "opacity-0")}
                      aria-hidden
                    />
                    <span className="truncate">{p.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {emptyMeansAll
            ? "Todavía no tenés productos en el catálogo: el descuento va a aplicar a toda la compra."
            : "Todavía no tenés productos en el catálogo: cargá alguno para poder regalarlo."}
        </p>
      ) : null}

      {showSelected && selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((p) => (
            <li key={p.d}>
              <Badge variant="outline" className="h-7 gap-1 pr-1 pl-2.5">
                <span className="max-w-[18ch] truncate">{p.title}</span>
                <button
                  type="button"
                  aria-label={`Quitar ${p.title}`}
                  className="grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(p.d)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
