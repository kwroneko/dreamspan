import { describe, expect, it } from "vitest"
import { formatByteSize, SIZE_UNITS } from "@dreamspan/shared/byteSize.ts"
import { editableByteSize, parseByteSize } from "../src/ui/byteSize.ts"

describe("byte sizes", () => {
  it("uses compact binary sizes consistently", () => {
    expect(formatByteSize(2147483648)).toBe("2 GB")
    expect(formatByteSize(209715200)).toBe("200 MB")
    expect(formatByteSize(900)).toBe("900 B")
    expect(formatByteSize(1536)).toBe("1.5 KB")
    expect(formatByteSize(1.5 * SIZE_UNITS.MB)).toBe("1.5 MB")
    expect(formatByteSize(512 * SIZE_UNITS.MB)).toBe("0.5 GB")
  })
  it("chooses the largest exact single-decimal editor unit and preserves legacy limits", () => {
    expect(editableByteSize(2147483648)).toEqual({ text: "2", unit: "GB" })
    expect(editableByteSize(209715200)).toEqual({ text: "200", unit: "MB" })
    expect(editableByteSize(1288490189)).toEqual({ text: "1.2", unit: "GB" })
    expect(editableByteSize(107374182)).toEqual({ text: "0.1", unit: "GB" })
    expect(formatByteSize(107374182)).toBe("0.1 GB")
    expect(editableByteSize(104858)).toEqual({ text: "0.1", unit: "MB" })
    expect(formatByteSize(104858)).toBe("0.1 MB")
    expect(editableByteSize(1.5 * SIZE_UNITS.GB)).toEqual({ text: "1.5", unit: "GB" })
    for (const bytes of [1, 104858, 107374182, 1288490189, 123456789, Number.MAX_SAFE_INTEGER]) {
      const { text, unit } = editableByteSize(bytes)
      expect(parseByteSize(text, unit)).toBe(bytes)
    }
  })
  it("converts decimals to the nearest byte and refuses invalid or oversized values", () => {
    expect(parseByteSize("1.5", "GB")).toBe(1610612736)
    expect(parseByteSize("0.1", "GB")).toBe(107374182)
    for (const text of ["", " ", "0", "-1", "NaN", "Infinity", "1e3", "1.2.3", "9007199254740991", "0.000000001"]) {
      expect(parseByteSize(text, "MB")).toBeNull()
    }
  })
})
