import { assert, describe, it } from "@effect/vitest"
import { existsSync, rmSync, writeFileSync } from "node:fs"
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
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
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

  it("builds the bundles even when a project that needs none sets up first", () =>
    keepingTmpdir(async () => {
      let builds = 0
      const holder = {}
      const live = project()
      const server = project()
      const liveDone = await makeSetup(null, holder)(live)
      const runDir = process.env.TMPDIR!
      const serverDone = await makeSetup(async () => void builds++, holder)(server)
      assert.strictEqual(builds, 1)
      assert.deepStrictEqual(live.provided, server.provided)
      liveDone()
      serverDone()
      assert.isFalse(existsSync(runDir))
    }))

  it("retries a rejected shared build while the live project still holds the run", () =>
    keepingTmpdir(async () => {
      const holder = {}
      const live = project()
      const liveDone = await makeSetup(null, holder)(live)
      const runDir = process.env.TMPDIR!
      try {
        const failed = new Error("build failed")
        let builds = 0
        const reject = makeSetup(async (bundleDir) => {
          builds++
          writeFileSync(join(bundleDir, "partial-build"), "")
          throw failed
        }, holder)
        const outcomes = await Promise.allSettled([reject(project()), reject(project())])
        assert.deepStrictEqual(outcomes, [
          { status: "rejected", reason: failed },
          { status: "rejected", reason: failed }
        ])
        assert.strictEqual(builds, 1)
        const server = project()
        const done = await makeSetup(async (bundleDir) => {
          assert.isFalse(existsSync(join(bundleDir, "partial-build")))
        }, holder)(server)
        assert.deepStrictEqual(server.provided, live.provided)
        done()
        liveDone()
        assert.isFalse(existsSync(runDir))
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    }))

  it("cleans up when the only project's build fails and allows a fresh run", () =>
    keepingTmpdir(async () => {
      const holder = {}
      const failed = new Error("build failed")
      let runDir: string | undefined
      try {
        const [failure] = await Promise.allSettled([
          makeSetup(async () => {
            runDir = process.env.TMPDIR!
            throw failed
          }, holder)(project())
        ])
        assert.deepStrictEqual(failure, { status: "rejected", reason: failed })
        assert.isFalse(existsSync(runDir!))
        const done = await makeSetup(async () => {}, holder)(project())
        done()
      } finally {
        if (runDir) rmSync(runDir, { recursive: true, force: true })
      }
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
