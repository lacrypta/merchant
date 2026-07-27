"use client"

import { orderKey, parseOrder, type Order } from "@/lib/domain/order"

/**
 * The active order, per merchant, in localStorage.
 *
 * This is what makes "refresh the page and get the SAME order id" true. We
 * persist the SIGNED zap request, not the inputs that produced it: rebuilding
 * from inputs would mint a new ephemeral key and a new created_at, and
 * therefore a different event hash — a different order number every time.
 */

export function loadOrder(merchantPubkey: string): Order | null {
  try {
    return parseOrder(
      window.localStorage.getItem(orderKey(merchantPubkey)),
      Date.now()
    )
  } catch {
    return null
  }
}

export function saveOrder(merchantPubkey: string, order: Order): void {
  try {
    window.localStorage.setItem(orderKey(merchantPubkey), JSON.stringify(order))
  } catch {
    /* private mode — the order lives in memory for this tab only */
  }
}

export function clearOrder(merchantPubkey: string): void {
  try {
    window.localStorage.removeItem(orderKey(merchantPubkey))
  } catch {
    /* ignore */
  }
}
