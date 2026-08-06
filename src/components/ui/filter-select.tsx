"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface FilterSelectOption {
  value: string
  label: string
}

interface FilterSelectProps {
  label: string
  value: string
  options: readonly FilterSelectOption[]
  onValueChange: (value: string) => void
  className?: string
}

/**
 * A compact, labelled select for filter toolbars. The label remains visible
 * once a value is chosen, so adjacent filters are easy to scan at a glance.
 */
function FilterSelect({
  label,
  value,
  options,
  onValueChange,
  className,
}: FilterSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          // The variant class wins over a bare `h-11`, so the height has to be
          // written with the same variant or the trigger silently stays at 32px
          // while every control beside it is 44.
          "h-11 data-[size=default]:h-11 min-w-[11.5rem] rounded-full border-border-strong bg-background px-3.5 shadow-sm transition-[border-color,background-color,box-shadow] hover:bg-muted/55 focus-visible:border-primary/60 focus-visible:ring-primary/20 data-[state=open]:border-primary/50 data-[state=open]:bg-muted/55 data-[state=open]:shadow-md",
          className
        )}
      >
        <span className="shrink-0 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <SelectValue className="min-w-0 flex-1 text-left font-semibold text-foreground" />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        sideOffset={6}
        className="min-w-[11.5rem] rounded-xl border-border-strong p-1.5 shadow-xl data-[position=popper]:h-auto data-[position=popper]:min-w-[var(--radix-select-trigger-width)]"
      >
        {/* INSIDE the group, not beside it. Radix wires the label as the
            group's accessible name, so its context consumer throws outright
            when it renders anywhere else — which took the whole /orders screen
            down, not just the dropdown. */}
        <SelectGroup className="p-0">
          <SelectLabel className="px-2.5 pt-1.5 pb-2 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase">
            {label}
          </SelectLabel>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="min-h-9 rounded-lg px-2.5 py-2 font-medium focus:bg-primary/10 focus:text-foreground"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export { FilterSelect }
