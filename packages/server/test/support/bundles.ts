// Global setup for the server tests: builds the worker bundles (ARCHITECTURE.md §3.6) once
// per run, before any test file starts, for every file that needs them, and outside any
// hook's time limit: once, at a load average of 85, a build in a beforeAll hook overran
// its 60 s. A build usually takes about 2 s, and 10 to 17 s of CPU (rolldown uses every
// core). Files that change a build copy it first.
import { mkdtempSync, rmSync } from "node:fs"
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

export default async function setup(project: TestProject) {
  const bundleDir = mkdtempSync(join(tmpdir(), "rp-bundles-"))
  await buildWorkers(bundleDir)
  project.provide("bundleDir", bundleDir)
  return () => rmSync(bundleDir, { recursive: true, force: true })
}
