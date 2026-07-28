import { describe, expect, it } from "vitest"

import { serializeCsv } from "@/lib/csv"

describe("serializeCsv", () => {
  it("preserves commas, quotes and line breaks in exported cells", () => {
    expect(
      serializeCsv(
        ["Producto", "Notas", "Sats"],
        [["Café, tostadas", 'Dijo "hola"\npara llevar', 250], ["Sin monto", null, undefined]]
      )
    ).toBe(
      'Producto,Notas,Sats\r\n"Café, tostadas","Dijo ""hola""\npara llevar",250\r\nSin monto,,'
    )
  })
})
