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
import { buildWorkers } from "../../scripts/build-workers.ts"

declare module "vitest" {
  export interface ProvidedContext {
    /** A directory holding a fresh build of the worker bundles, shared by every test file. */
    bundleDir: string
  }
}

const BUNDLES = "bundles"

export default async function setup(project: TestProject) {
  const runDir = mkdtempSync(join(tmpdir(), "rp-test-run-"))
  process.env.TMPDIR = runDir
  const bundleDir = join(runDir, BUNDLES)
  mkdirSync(bundleDir)
  await buildWorkers(bundleDir)
  // Bundled native dependencies stay external. These throwaway bundles are outside the
  // repository's node_modules ancestry; production bundles live inside it.
  mkdirSync(join(bundleDir, "node_modules"))
  symlinkSync(
    fileURLToPath(new URL("../../../../node_modules/sharp", import.meta.url)),
    join(bundleDir, "node_modules/sharp")
  )
  project.provide("bundleDir", bundleDir)
  return () => {
    const left = readdirSync(runDir).filter((name) => name !== BUNDLES)
    rmSync(runDir, { recursive: true, force: true })
    if (left.length > 0) {
      throw new Error(`the tests left ${left.length} temporary entries behind: ${left.slice(0, 20).join(", ")}`)
    }
  }
}
