import { z } from "zod"

import { CURRENCIES } from "@/lib/domain/price"

/**
 * Validation for products authored HERE.
 *
 * Stricter than the parser on purpose: the parser must tolerate whatever is
 * on the relays (missing prices, foreign currencies), while this governs what
 * we let a merchant create — and the POS can only ring up ARS/USD/SAT.
 */
export const productFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Poné un nombre")
      .max(120, "Máximo 120 caracteres"),
    summary: z.string().trim().max(200, "Máximo 200 caracteres").optional(),
    description: z.string().max(20_000).default(""),
    amount: z
      .number({ message: "Poné un precio" })
      .positive("Tiene que ser mayor a 0"),
    currency: z.enum(CURRENCIES as unknown as [string, ...string[]]),
    trackStock: z.boolean(),
    stock: z.number().int("Tiene que ser un número entero").min(0).nullable(),
    visibility: z.enum(["on-sale", "hidden", "pre-order"]),
    status: z.enum(["active", "sold"]),
    categories: z.array(z.string()).max(4, "Máximo 4 categorías"),
    imageUrl: z
      .string()
      .trim()
      .url("Tiene que ser una URL válida")
      .optional()
      .or(z.literal("")),
  })
  .refine((v) => v.currency !== "SAT" || Number.isInteger(v.amount), {
    message: "En sats el precio tiene que ser entero",
    path: ["amount"],
  })
  .refine((v) => !v.trackStock || v.stock !== null, {
    message: "Poné la cantidad en stock",
    path: ["stock"],
  })

export type ProductFormValues = z.input<typeof productFormSchema>
export type ProductFormOutput = z.output<typeof productFormSchema>
