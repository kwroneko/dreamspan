import { expect, it } from "vitest"
import { makeLineageCache } from "../src/db/lcmLineageCache.ts"

it("requires the same sealed header and bounds retained lineage across hundreds of branches", () => {
  const cache = makeLineageCache<{ id: string }>(4, 500)
  for (let n = 0; n < 400; n++) cache.set(`summary-${n}`, "sealed", [{ id: `child-${n}` }], true)
  expect(cache.get("summary-0", "sealed")).toBeUndefined()
  expect(cache.get("summary-399", "sealed")?.valid).toBe(true)
  expect(cache.get("summary-399", "a different header")).toBeUndefined()
  cache.set("too large", "sealed", [{ id: "x".repeat(1000) }], true)
  expect(cache.get("too large", "sealed")).toBeUndefined()
  expect(cache.get("summary-399", "sealed")?.children).toEqual([{ id: "child-399" }])
})

it("updates a proof without retaining an older header", () => {
  const cache = makeLineageCache<string>()
  cache.set("same", "old", ["a"], undefined)
  cache.set("same", "new", ["b"], false)
  expect(cache.get("same", "old")).toBeUndefined()
  expect(cache.get("same", "new")?.valid).toBe(false)
  expect(cache.get("same", "new")?.children).toEqual(["b"])
})
