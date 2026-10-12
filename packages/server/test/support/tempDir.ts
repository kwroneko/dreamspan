// The only way server tests get a temporary directory: each one is removed when its test
// file ends, whether the tests passed or not. Directories outlive their test so that
// workers still shutting down never find their files gone. The global setup
// (support/globalSetup.ts) checks that a run leaves nothing behind.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

const made: Array<string> = []

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh directory named `rp-<name>-…`, removed at the end of the test file. */
export const tempDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `rp-${name}-`))
  made.push(dir)
  return dir
}
