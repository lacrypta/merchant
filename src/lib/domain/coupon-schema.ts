import { z } from "zod"

import {
  MAX_COUPON_DESCRIPTION,
  MAX_COUPON_NAME,
  MAX_COUPON_PRODUCTS,
  MAX_COUPON_USES,
  MAX_FREE_QTY,
  MAX_MULTIBUY_QTY,
  type Benefit,
  type FreeUnits,
} from "@/lib/domain/coupon"
import { CURRENCIES } from "@/lib/domain/price"

/**
 * Validation for the coupon form.
 *
 * One flat object rather than a zod discriminated union, because the form keeps
 * every field mounted as the merchant switches type — a union would throw away
 * what they typed for "3x2" the moment they peeked at "% de descuento". The
 * `superRefine` then checks only the fields the chosen type actually uses.
 */
export const couponFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Poné un nombre")
      .max(MAX_COUPON_NAME, `Máximo ${MAX_COUPON_NAME} caracteres`),
    description: z
      .string()
      .trim()
      .max(MAX_COUPON_DESCRIPTION, `Máximo ${MAX_COUPON_DESCRIPTION} caracteres`)
      .default(""),
    imageUrl: z
      .string()
      .trim()
      .url("Tiene que ser una URL válida")
      .startsWith("https://", "Tiene que empezar con https://")
      .optional()
      .or(z.literal("")),
    type: z.enum(["percent", "fixed", "multibuy", "buyXgetY", "freeItems"]),

    percent: z.number().nullable(),
    amount: z.number().nullable(),
    currency: z.enum(CURRENCIES as unknown as [string, ...string[]]),
    buyQty: z.number().nullable(),
    payQty: z.number().nullable(),
    /** Empty means "todos los productos" — see ProductScope in coupon.ts. */
    productDs: z.array(z.string()),
    buyProductD: z.string(),
    giftProductD: z.string(),
    /** freeItems: what the coupon hands over. Empty is invalid, never "todos". */
    freeItems: z.array(z.object({ d: z.string(), qty: z.number() })),

    /** null ⇒ sin tope. Applies to every type — see DiscountCap. */
    capAmount: z.number().nullable(),
    capCurrency: z.enum(CURRENCIES as unknown as [string, ...string[]]),

    /** null ⇒ sin límite. */
    maxUses: z.number().nullable(),
    /** "" ⇒ sin vencimiento. An `<input type="date">` value, local time. */
    expiresAt: z.string(),
  })
  .superRefine((v, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message })

    switch (v.type) {
      case "percent":
        if (v.percent === null) fail("percent", "Poné un porcentaje")
        else if (!Number.isInteger(v.percent)) fail("percent", "Tiene que ser un número entero")
        else if (v.percent < 1 || v.percent > 100) fail("percent", "Tiene que ser entre 1 y 100")
        break

      case "fixed":
        if (v.amount === null) fail("amount", "Poné un monto")
        else if (v.amount <= 0) fail("amount", "Tiene que ser mayor a 0")
        else if (v.currency === "SAT" && !Number.isInteger(v.amount)) {
          fail("amount", "En sats el monto tiene que ser entero")
        }
        break

      case "multibuy":
        if (v.buyQty === null) fail("buyQty", "Poné cuántos se llevan")
        else if (!Number.isInteger(v.buyQty) || v.buyQty < 2) {
          fail("buyQty", "Tiene que ser un entero de 2 o más")
        } else if (v.buyQty > MAX_MULTIBUY_QTY) {
          fail("buyQty", `Máximo ${MAX_MULTIBUY_QTY}`)
        }
        if (v.payQty === null) fail("payQty", "Poné cuántos se pagan")
        else if (!Number.isInteger(v.payQty) || v.payQty < 1) {
          fail("payQty", "Tiene que ser un entero de 1 o más")
        } else if (v.buyQty !== null && v.payQty >= v.buyQty) {
          fail("payQty", "Hay que pagar menos de lo que se lleva")
        }
        break

      case "buyXgetY":
        if (!v.buyProductD) fail("buyProductD", "Elegí el producto a comprar")
        if (!v.giftProductD) fail("giftProductD", "Elegí el producto de regalo")
        break

      case "freeItems":
        if (v.freeItems.length === 0) {
          fail("freeItems", "Elegí al menos un producto")
        } else if (v.freeItems.length > MAX_COUPON_PRODUCTS) {
          fail("freeItems", `No más de ${MAX_COUPON_PRODUCTS} productos`)
        } else if (
          v.freeItems.some(
            (i) => !Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_FREE_QTY
          )
        ) {
          fail("freeItems", `Las cantidades van de 1 a ${MAX_FREE_QTY}`)
        }
        break
    }

    if (v.capAmount !== null) {
      if (v.capAmount <= 0) fail("capAmount", "Tiene que ser mayor a 0")
      else if (v.capCurrency === "SAT" && !Number.isInteger(v.capAmount)) {
        fail("capAmount", "En sats el tope tiene que ser entero")
      }
    }

    if (v.type !== "buyXgetY" && v.productDs.length > MAX_COUPON_PRODUCTS) {
      fail("productDs", `No más de ${MAX_COUPON_PRODUCTS} productos`)
    }

    if (v.maxUses !== null) {
      if (!Number.isInteger(v.maxUses) || v.maxUses < 1) {
        fail("maxUses", "Tiene que ser un entero de 1 o más")
      } else if (v.maxUses > MAX_COUPON_USES) {
        fail("maxUses", `Máximo ${MAX_COUPON_USES}`)
      }
    }

    if (v.expiresAt && Number.isNaN(Date.parse(v.expiresAt))) {
      fail("expiresAt", "Fecha inválida")
    }
  })

export type CouponFormValues = z.input<typeof couponFormSchema>
export type CouponFormOutput = z.output<typeof couponFormSchema>

/** An empty picker means "todos", which the benefit spells as an absent key. */
const scope = (productDs: string[]) =>
  productDs.length > 0 ? { productDs } : {}

/** Same idea for the ceiling: no amount means no key, not `cap: null`. */
const capOf = (v: CouponFormOutput) =>
  v.capAmount === null
    ? {}
    : { cap: { amount: v.capAmount, currency: v.capCurrency as "ARS" | "USD" | "SAT" } }

/** Collapse the form's flat fields into the benefit the API expects. */
export function benefitFromForm(v: CouponFormOutput): Benefit {
  const cap = capOf(v)
  switch (v.type) {
    case "percent":
      return { type: "percent", percent: v.percent!, ...scope(v.productDs), ...cap }
    case "fixed":
      return {
        type: "fixed",
        amount: v.amount!,
        currency: v.currency as "ARS" | "USD" | "SAT",
        ...scope(v.productDs),
        ...cap,
      }
    case "multibuy":
      return {
        type: "multibuy",
        buyQty: v.buyQty!,
        payQty: v.payQty!,
        ...scope(v.productDs),
        ...cap,
      }
    case "buyXgetY":
      return {
        type: "buyXgetY",
        buyProductD: v.buyProductD,
        giftProductD: v.giftProductD,
        ...cap,
      }
    case "freeItems":
      return { type: "freeItems", items: v.freeItems, ...cap }
  }
}

/** Spread a stored benefit back across the form's fields. */
export function formValuesFromBenefit(b: Benefit): Pick<
  CouponFormOutput,
  | "type"
  | "percent"
  | "amount"
  | "currency"
  | "buyQty"
  | "payQty"
  | "productDs"
  | "buyProductD"
  | "giftProductD"
  | "freeItems"
  | "capAmount"
  | "capCurrency"
> {
  const base = {
    capAmount: b.cap?.amount ?? null,
    capCurrency: b.cap?.currency ?? "ARS",
    percent: null,
    amount: null,
    currency: "ARS",
    buyQty: null,
    payQty: null,
    productDs: [] as string[],
    buyProductD: "",
    giftProductD: "",
    freeItems: [] as FreeUnits[],
  }
  switch (b.type) {
    case "percent":
      return {
        ...base,
        type: "percent",
        percent: b.percent,
        productDs: b.productDs ?? [],
      }
    case "fixed":
      return {
        ...base,
        type: "fixed",
        amount: b.amount,
        currency: b.currency,
        productDs: b.productDs ?? [],
      }
    case "multibuy":
      return {
        ...base,
        type: "multibuy",
        buyQty: b.buyQty,
        payQty: b.payQty,
        productDs: b.productDs ?? [],
      }
    case "buyXgetY":
      return {
        ...base,
        type: "buyXgetY",
        buyProductD: b.buyProductD,
        giftProductD: b.giftProductD,
      }
    case "freeItems":
      return { ...base, type: "freeItems", freeItems: b.items }
  }
}
