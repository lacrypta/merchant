export type CsvCell = string | number | boolean | null | undefined

function escapeCsvCell(value: CsvCell) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Serializes a rectangular table as RFC 4180-compatible UTF-8 CSV text. */
export function serializeCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[]
) {
  return [...[headers], ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n")
}
