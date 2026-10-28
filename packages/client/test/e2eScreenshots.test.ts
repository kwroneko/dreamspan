// A browser test that saves screenshots without SCREENSHOT_DIR set puts them in a temporary
// folder, never a path in the repository (a relative default wrote them into the working tree).
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const e2e = join(import.meta.dirname, "..", "e2e")

describe("browser tests' screenshots", () => {
  it("default to the temporary folder, not a path in the repository", () => {
    const relative = readdirSync(e2e)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /SCREENSHOT_DIR\s*\?\?\s*["'`]/.test(readFileSync(join(e2e, file), "utf8")))
    expect(relative).toEqual([])
  })
})
