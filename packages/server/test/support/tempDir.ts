// The only way server tests get a temporary directory. Running files remove them in
// afterAll, after their scopes close and before Vitest reports the file finished. The
// environment also removes them if collection failed or all tests were filtered out.
// The global setup checks that the run leaves no temporary entries behind.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import { cleanupTempDirs, trackTempDir } from "./tempDirCleanup.ts"

afterAll(() => cleanupTempDirs(globalThis))

/** A fresh directory named `rp-<name>-…`, removed at the end of the test file. */
export const tempDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `rp-${name}-`))
  trackTempDir(dir)
  return dir
}
