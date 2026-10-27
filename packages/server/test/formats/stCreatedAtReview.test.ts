import { expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { parseStCreatedAt } from "../../src/formats/stCreatedAt.ts"

it("accepts ST numeric timestamp strings", () => {
  expect(parseStCreatedAt("1720747897123")).toBe(1720747897123)
})

it("interprets ST humanized timestamps as UTC on a non-UTC host", () => {
  const module = new URL("../../src/formats/stCreatedAt.ts", import.meta.url).href
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { parseStCreatedAt } from ${JSON.stringify(module)}; console.log(parseStCreatedAt('2024-07-12@01h31m37s123ms'))`
    ],
    { env: { ...process.env, TZ: "Europe/Rome" }, encoding: "utf8" }
  )
  expect(child.status).toBe(0)
  expect(Number(child.stdout.trim())).toBe(Date.parse("2024-07-12T01:31:37.123Z"))
})
