// Global setup for the server tests.
//
// Temporary files: the run gets one directory, and TMPDIR points the test processes into
// it, so every tmpdir() lands there, from tempDir() or anything else. At the end, anything
// left in it fails the run, and the directory goes either way. Comparing counts of /tmp/rp-*
// instead would race with other test runs on the same host.
//
// Worker bundles (ARCHITECTURE.md §3.6) are built once per run, before any test file
// starts, for every file that needs them, and outside any hook's time limit: once, at a
// load average of 85, a build in a beforeAll hook overran its 60 s. A build usually takes
// about 2 s, and 10 to 17 s of CPU (rolldown uses every core). Files that change a build
// copy it first.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { build } from "rolldown"
import { buildWorkers } from "../../scripts/build-workers.ts"

declare module "vitest" {
  export interface ProvidedContext {
    /** A directory holding a fresh build of the worker bundles, shared by every test file. */
    bundleDir: string
  }
}

const BUNDLES = "bundles"

/** The run's directory, shared by every project that has this setup (server, server-slow, server-live). */
interface Run {
  readonly dir: string
  readonly bundleDir: string
  readonly previousTmpdir: string | undefined
  /** The bundle build, started by the first project that builds; the live project doesn't. */
  built?: Promise<void>
  users: number
}

/**
 * A setup for each project of a run. A run of several server projects (`npx vitest run`, or
 * filters matching files of each) gets one directory and one build: a second directory would
 * land inside the first, since TMPDIR points there by then, and the first's check would find
 * it. Vitest may load this module once per project, so the run lives in `holder`, by default
 * `globalThis`. `build` is null for a project that needs no bundles (server-live): it shares
 * the directory but doesn't decide whether the bundles get built, whichever project's setup
 * Vitest runs first. (When the live project's empty build could be the run's only one, a
 * filter matching a live file and server files failed every server test with
 * WorkerBundleMissing.)
 */
export const makeSetup =
  (
    build: ((bundleDir: string) => Promise<void>) | null,
    holder: { rpTestRun?: Run } = globalThis as { rpTestRun?: Run }
  ) =>
  async (project: Pick<TestProject, "provide">) => {
    if (holder.rpTestRun === undefined) {
      const dir = mkdtempSync(join(tmpdir(), "rp-test-run-"))
      const bundleDir = join(dir, BUNDLES)
      mkdirSync(bundleDir)
      holder.rpTestRun = { dir, bundleDir, previousTmpdir: process.env.TMPDIR, users: 0 }
      process.env.TMPDIR = dir
    }
    const run = holder.rpTestRun
    run.users++
    const release = () => {
      if (--run.users > 0) return
      delete holder.rpTestRun
      if (run.previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = run.previousTmpdir
      const left = readdirSync(run.dir).filter((name) => name !== BUNDLES)
      rmSync(run.dir, { recursive: true, force: true })
      if (left.length > 0) {
        throw new Error(`the tests left ${left.length} temporary entries behind: ${left.slice(0, 20).join(", ")}`)
      }
    }
    try {
      if (build !== null) {
        run.built ??= Promise.resolve()
          .then(() => build(run.bundleDir))
          .catch((error) => {
            delete run.built
            rmSync(run.bundleDir, { recursive: true, force: true })
            mkdirSync(run.bundleDir)
            throw error
          })
        await run.built
      }
      project.provide("bundleDir", run.bundleDir)
      return release
    } catch (error) {
      release()
      throw error
    }
  }

const buildBundles = async (bundleDir: string) => {
  await buildWorkers(bundleDir)
  // LCM fixtures issue many small batches. Strip this worker once too, instead of
  // starting Node's TypeScript/Wasm loader for every batch under the test's deadline.
  await build({
    input: fileURLToPath(new URL("./lcmFixtureWorker.ts", import.meta.url)),
    platform: "node",
    output: { file: join(bundleDir, "lcmFixture.mjs"), format: "esm" },
    logLevel: "warn"
  })
  // Bundled native dependencies stay external. These throwaway bundles are outside the
  // repository's node_modules ancestry; production bundles live inside it.
  mkdirSync(join(bundleDir, "node_modules"))
  for (const name of ["sharp", "tiktoken", "llama3-tokenizer-js"])
    symlinkSync(
      fileURLToPath(new URL(`../../../../node_modules/${name}`, import.meta.url)),
      join(bundleDir, `node_modules/${name}`)
    )
  // This helper is also used by Playwright, where Vitest's inject() is unavailable.
  process.env.RP_TEST_LCM_FIXTURE_WORKER = join(bundleDir, "lcmFixture.mjs")
}

export default makeSetup(buildBundles)
