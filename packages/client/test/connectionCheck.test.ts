// The model list line of a connection test.
import { describe, expect, it } from "vitest"
import { listSummary } from "../src/features/connections/check.tsx"

describe("a connection test's model list line", () => {
  it("counts one model in the singular", () => {
    expect(listSummary({ catalog: false, models: 1, ms: 3 })).toBe("1 model listed in 3 ms.")
    expect(listSummary({ catalog: true, models: 1, ms: null })).toBe("1 model in the built-in list.")
  })
  it("counts other numbers in the plural", () => {
    expect(listSummary({ catalog: false, models: 2, ms: null })).toBe("2 models listed.")
    expect(listSummary({ catalog: false, models: 0, ms: 1500 })).toBe("0 models listed in 1.5 s.")
    expect(listSummary({ catalog: true, models: 40, ms: null })).toBe("40 models in the built-in list.")
  })
})
