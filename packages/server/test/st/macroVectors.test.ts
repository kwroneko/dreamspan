// The ST harness's macro vectors cite ARCHITECTURE by section and text; the section must
// still say so.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEVIATIONS } from "./macroVectors.ts"

const architecture = readFileSync(new URL("../../../../ARCHITECTURE.md", import.meta.url), "utf8").split("\n")

/** The section's text: from its heading to the next heading of the same level or above. */
const section = (heading: string) => {
  const start = architecture.findIndex((line) => /^#+ /.test(line) && line.replace(/^#+ /, "") === heading)
  if (start === -1) return undefined
  const level = architecture[start]!.indexOf(" ")
  const end = architecture.findIndex((line, i) => i > start && /^#+ /.test(line) && line.indexOf(" ") <= level)
  return architecture.slice(start + 1, end === -1 ? undefined : end).join("\n")
}

describe("the macro vectors' documented deviations", () => {
  it.each(Object.entries(DEVIATIONS))("%s cites text its section contains", (_, { section: heading, quote }) => {
    const text = section(heading)
    expect(text, `no section "${heading}"`).toBeDefined()
    expect(text).toContain(quote)
  })
})
