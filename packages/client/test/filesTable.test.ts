import { describe, expect, it } from "vitest"
import { parseTable } from "../src/features/files/table.ts"

describe("CSV and TSV tables", () => {
  it("reads quoted fields, doubled quotes and newlines inside quotes, with any line ending", () => {
    const table = parseTable('name,notes\r\n"Wren, the fox","said ""hi""\nand left"\nAsh,\n', ",")
    expect(table.rows).toEqual([
      ["name", "notes"],
      ["Wren, the fox", 'said "hi"\nand left'],
      ["Ash", ""]
    ])
    expect(table.total).toBe(2)
  })

  it("pads short rows, splits TSV on tabs and keeps a last line without an ending", () => {
    expect(parseTable("a\tb\tc\n1\t2", "\t").rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", ""]
    ])
  })

  it("shows the header and the first rows, and counts them all", () => {
    const text = ["n", ...Array.from({ length: 50 }, (_, i) => String(i))].join("\n")
    const table = parseTable(text, ",", 10)
    expect(table.rows).toHaveLength(11)
    expect(table.total).toBe(50)
  })

  it("keeps a final quoted empty cell without a line ending", () => {
    for (const delimiter of [",", "\t"] as const)
      expect(parseTable('heading\n""', delimiter)).toEqual({ rows: [["heading"], [""]], total: 1 })
  })
})
