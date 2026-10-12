// Temporary files, as the server tests have them (packages/server/test/support/globalSetup.ts):
// the run gets one directory, TMPDIR points everything into it, and anything left in it at
// the end fails the run. The fixture cache is the exception: it lives in the system's temp
// directory, outside the run, so the next run reuses it.
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export default function setup() {
  process.env.RP_PERF_CACHE_ROOT = tmpdir()
  const runDir = mkdtempSync(join(tmpdir(), "rp-perf-run-"))
  process.env.TMPDIR = runDir
  return () => {
    const left = readdirSync(runDir)
    rmSync(runDir, { recursive: true, force: true })
    if (left.length > 0) {
      throw new Error(`the harness left ${left.length} temporary entries behind: ${left.slice(0, 20).join(", ")}`)
    }
  }
}
