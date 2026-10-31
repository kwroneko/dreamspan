import { assert, describe, it } from "@effect/vitest"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeSetup } from "./support/globalSetup.ts"

/** A project for the setup to provide to, recording what it gets. */
const project = () => {
  const provided: Array<unknown> = []
  return { provided, provide: (_key: string, value: unknown) => void provided.push(value) }
}

/** Runs `body` with TMPDIR restored after it: the setup points TMPDIR at its run's directory. */
const keepingTmpdir = async (body: () => Promise<void>) => {
  const before = process.env.TMPDIR
  try {
    await body()
  } finally {
    process.env.TMPDIR = before
  }
}

describe("the server tests' global setup", () => {
  it("gives both server projects of a run one directory and one build, and removes it after the last", () =>
    keepingTmpdir(async () => {
      let builds = 0
      const setup = makeSetup(async () => void builds++, {})
      const server = project()
      const slow = project()
      const [serverDone, slowDone] = await Promise.all([setup(server), setup(slow)])
      const runDir = process.env.TMPDIR!
      assert.strictEqual(builds, 1)
      assert.deepStrictEqual(server.provided, [join(runDir, "bundles")])
      assert.deepStrictEqual(slow.provided, server.provided)
      serverDone()
      assert.isTrue(existsSync(runDir))
      slowDone()
      assert.isFalse(existsSync(runDir))
    }))

  it("fails the run when a test leaves a temporary entry behind", () =>
    keepingTmpdir(async () => {
      const done = await makeSetup(async () => {}, {})(project())
      const runDir = process.env.TMPDIR!
      writeFileSync(join(runDir, "rp-left-behind"), "")
      assert.throws(done, /left 1 temporary entries behind: rp-left-behind/)
      assert.isFalse(existsSync(runDir))
    }))
})
