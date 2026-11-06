// Playwright global setup: Vite's dependency pre-bundle, made once before any test starts.
// The specs that run the client on a Vite dev server (registry replacement needs its live
// module graph) otherwise each start a cold scan and bundle of every dependency, and in
// parallel clear one another's half-written cache: on a loaded host that took six minutes,
// far past their setup budget. The deprecated `vite optimize` is the one entry point that
// waits for the bundle. A cache newer than the lockfile and the Vite config is current
// (`npm ci` removes it), which saves loading the config only to compare hashes.
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const modified = (path: string) => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Number.POSITIVE_INFINITY

export default function viteDeps() {
  const client = resolve(import.meta.dirname, "../..")
  const cache = modified(join(client, "node_modules/.vite/deps/_metadata.json"))
  const inputs = [join(client, "../../package-lock.json"), join(client, "vite.config.ts")]
  if (cache !== Number.POSITIVE_INFINITY && inputs.every((input) => modified(input) < cache)) return
  const vite = join(createRequire(join(client, "package.json")).resolve("vite/package.json"), "../bin/vite.js")
  const run = spawnSync(process.execPath, [vite, "optimize", "--logLevel", "warn"], { cwd: client, stdio: "inherit" })
  if (run.status !== 0) throw new Error(`vite optimize exited with ${run.status ?? run.signal}`)
}
