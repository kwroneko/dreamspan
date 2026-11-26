// The worker bundles' stamp: which sources they were built from, and a hash of them, so
// the server can refuse bundles that no longer match its own code (ARCHITECTURE.md §3.6).
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository root. Stamped paths are relative to it. */
const root = fileURLToPath(new URL("../../../../", import.meta.url))

interface Stamp {
  readonly sources: ReadonlyArray<string>
  readonly hash: string
}

const STAMP_FILE = "stamp.json"

/** Dependencies are bundled too, so the lockfile counts as a source. */
const LOCKFILE = "package-lock.json"

const hashOf = (sources: ReadonlyArray<string>) => {
  const hash = createHash("sha256")
  for (const source of sources) {
    const file = join(root, source)
    hash.update(source).update("\0")
    hash.update(existsSync(file) ? readFileSync(file) : "missing").update("\0")
  }
  return hash.digest("hex")
}

/** Records the repository files among the bundled modules, plus the lockfile. */
export const writeStamp = (bundleDir: string, moduleIds: Iterable<string>) => {
  const sources = new Set([LOCKFILE])
  for (const id of moduleIds) {
    if (!isAbsolute(id)) continue
    // The bundler can report slash-delimited paths on Windows. relative() accepts
    // either separator there and returns a native path with the drive resolved.
    const path = relative(root, id)
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue
    const parts = path.split(sep)
    if (!parts.includes("node_modules")) sources.add(parts.join("/"))
  }
  const sorted = [...sources].sort()
  const stamp: Stamp = { sources: sorted, hash: hashOf(sorted) }
  writeFileSync(join(bundleDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
}

/** Whether the bundles in `bundleDir` were built from the sources as they are now. */
export const stampMatches = (bundleDir: string) => {
  const file = join(bundleDir, STAMP_FILE)
  if (!existsSync(file)) return false
  const stamp = JSON.parse(readFileSync(file, "utf8")) as Stamp
  return hashOf(stamp.sources) === stamp.hash
}
