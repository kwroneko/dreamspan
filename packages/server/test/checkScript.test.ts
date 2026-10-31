// scripts/check.ts, run on a package.json whose scripts stand in for the real steps.
import { assert, describe, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tempDir } from "./support/tempDir.ts"

const check = fileURLToPath(new URL("../../../scripts/check.ts", import.meta.url))

const runCheck = (scripts: Record<string, string>) => {
  const dir = tempDir("check")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }))
  return spawnSync(process.execPath, [check], { cwd: dir, encoding: "utf8" })
}

const passing = { typecheck: "true && true", lint: "true", "format:check": "true", knip: "true", test: "true" }

describe("npm run check", () => {
  it("passes when every step passes", () => {
    const run = runCheck(passing)
    assert.strictEqual(run.status, 0)
    assert.match(run.stdout, /check: all passed\n$/)
  })

  it("fails when any step fails, and ends with each failed step's output and name", () => {
    const run = runCheck({
      ...passing,
      typecheck: "true && echo 'x.ts(1,1): error TS2322' >&2; exit 2",
      knip: "echo 'Unused export foo'; exit 1",
      // Ends last, so the other steps' failures would otherwise be above its output.
      test: "sleep 0.5; echo 'Test Files  1 failed'; exit 1"
    })
    assert.strictEqual(run.status, 1)
    const testsAt = run.stdout.indexOf("Test Files  1 failed")
    const end = run.stdout.slice(testsAt)
    assert.include(end, "── typecheck: echo 'x.ts(1,1): error TS2322' >&2; exit 2: failed\nx.ts(1,1): error TS2322")
    assert.include(end, "── knip: failed\nUnused export foo")
    assert.match(end, /check: failed: typecheck: echo .*; exit 2, knip, test\n$/)
    assert.notInclude(end, "typecheck: true:")
  })

  it("fails when only the tests fail", () => {
    const run = runCheck({ ...passing, test: "exit 1" })
    assert.strictEqual(run.status, 1)
    assert.match(run.stdout, /check: failed: test\n$/)
  })
})
