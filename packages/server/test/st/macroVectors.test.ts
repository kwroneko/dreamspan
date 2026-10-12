// The ST harness's macro vectors cite ARCHITECTURE by line; the lines must still say so.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEVIATIONS } from "./macroVectors.ts"

const architecture = readFileSync(new URL("../../../../ARCHITECTURE.md", import.meta.url), "utf8").split("\n")

describe("the macro vectors' documented deviations", () => {
  it.each(Object.entries(DEVIATIONS))("%s cites the line that documents it", (_, { line, quote }) => {
    expect(architecture[line - 1]).toContain(quote)
  })
})
