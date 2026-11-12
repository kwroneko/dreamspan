import { assert, it } from "@effect/vitest"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "./support/tempDir.ts"
import { cleanupTempDirs } from "./support/tempDirCleanup.ts"
import environment from "./support/testEnvironment.ts"

it("removes only a file's owned directories, including contents, and tolerates repeated teardown", () => {
  const owned = tempDir("owned")
  const other = tempDir("other")
  writeFileSync(join(owned, "fixture"), "synthetic")
  const context = { rpTestTempDirs: [owned] }
  cleanupTempDirs(context)
  assert.isFalse(existsSync(owned))
  assert.isTrue(existsSync(other))
  assert.deepStrictEqual(context.rpTestTempDirs, [])
  cleanupTempDirs(context)
})

it("tears down a VM's collection-time directories without running suite hooks", async () => {
  const owned = tempDir("collected")
  const vm = await environment.setupVM({})
  try {
    vm.getVmContext().rpTestTempDirs = [owned]
    // A skipped file or a collection error reaches environment teardown without hooks.
    assert.isTrue(existsSync(owned))
  } finally {
    await vm.teardown()
  }
  assert.isFalse(existsSync(owned))
})
