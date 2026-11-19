// The app's own source for commands and the file tools (spec/FILES-AND-ENVIRONMENT.md §3.6): at
// startup the shipped source of the running version (`packages/*/src`, the plugin API among
// them, `spec/` and ARCHITECTURE.md, text files only) is copied into
// DATA_DIR/app-source/<stamp>/ with a SOURCE.md naming the version, and every sandbox binds it
// read-only at /app-source. It's the code the server runs, with no data, configuration or
// secrets: what plugin work needs to read. The copy is made once per version (its stamp is a
// hash of what it holds) and older copies are removed.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The app's install folder (the repository root, or /app in the image). */
const APP_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "")

/** What is copied, relative to the app's folder. */
const SOURCE_FOLDERS = [
  "packages/shared/src",
  "packages/server/src",
  "packages/client/src",
  "packages/plugin-api/src",
  "spec"
] as const
const SOURCE_FILES = ["ARCHITECTURE.md", "README.md"] as const
/** Text only: no tokenizer tables, images or other large data. */
const TEXT = /\.(?:ts|tsx|js|mjs|cjs|css|html|md|json|txt)$/
const FILE_MAX_BYTES = 2 ** 20
const COPY_MAX_FILES = 20_000

export interface AppSourceCopy {
  /** The copy on the host, bound at /app-source. */
  readonly folder: string
  readonly stamp: string
  readonly files: number
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep)

/** The source files to copy (relative paths), never anything under the data folder or a link. */
const listSource = async (root: string, dataDir: string) => {
  const data = resolve(dataDir)
  const found: Array<string> = []
  const visit = async (folder: string): Promise<void> => {
    if (inside(resolve(root, folder), data)) return
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = `${folder}/${entry.name}`
      if (inside(resolve(root, path), data) || entry.name.startsWith(".")) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && TEXT.test(entry.name)) {
        if (found.length >= COPY_MAX_FILES) throw new Error("The app's source has more files than are copied.")
        found.push(path)
      }
    }
  }
  for (const folder of SOURCE_FOLDERS) await visit(folder)
  for (const file of SOURCE_FILES) if ((await lstat(join(root, file)).catch(() => null))?.isFile()) found.push(file)
  return found
}

/** The running version's commit: SOURCE_COMMIT, else the checkout's own when it has one. */
const sourceCommit = (root: string) => {
  const named = process.env.SOURCE_COMMIT?.trim()
  if (named && /^[0-9a-f]{7,64}$/.test(named)) return named
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
  })
  const found = git.status === 0 ? git.stdout.trim() : ""
  return /^[0-9a-f]{40,64}$/.test(found) ? found : null
}

/**
 * Makes the copy for the running version, if it isn't there yet, and removes older ones.
 * `root` is the app's folder (tests pass a synthetic one).
 */
export const prepareAppSource = async (dataDir: string, root = APP_ROOT): Promise<AppSourceCopy> => {
  const base = join(dataDir, "app-source")
  await mkdir(base, { recursive: true, mode: 0o700 })
  const paths = await listSource(root, dataDir)
  const contents = new Map<string, Buffer>()
  const hash = createHash("sha256")
  for (const path of paths) {
    const info = await lstat(join(root, path))
    if (!info.isFile() || info.size > FILE_MAX_BYTES) continue
    const bytes = await readFile(join(root, path))
    contents.set(path, bytes)
    hash.update(path).update("\0").update(bytes).update("\0")
  }
  const commit = sourceCommit(root)
  hash.update(commit ?? "")
  const stamp = hash.digest("hex").slice(0, 16)
  const folder = join(base, stamp)
  if (!(await lstat(join(folder, "SOURCE.md")).catch(() => null))?.isFile()) {
    const temporary = join(base, `.making-${process.pid}-${stamp}`)
    await rm(temporary, { recursive: true, force: true })
    for (const [path, bytes] of contents) {
      await mkdir(dirname(join(temporary, path)), { recursive: true })
      await writeFile(join(temporary, path), bytes, { mode: 0o644 })
    }
    await writeFile(
      join(temporary, "SOURCE.md"),
      [
        "# The app's source",
        "",
        "A read-only copy of the source of the version of the app that is running, for reading while you work",
        "on plugins: `packages/*/src` (the plugin API is `packages/plugin-api/src`), `spec/` and",
        "`ARCHITECTURE.md`. It has no data, settings or secrets, and changing it changes nothing.",
        "",
        `Version: ${commit ?? "not recorded"}`,
        `Copy: ${stamp} (${contents.size} files)`,
        ""
      ].join("\n"),
      { mode: 0o644 }
    )
    await rm(folder, { recursive: true, force: true })
    await rename(temporary, folder)
  }
  // Older versions' copies, and copies a stopped start left half made.
  for (const name of await readdir(base))
    if (name !== stamp && relative(base, join(base, name)) === name)
      await rm(join(base, name), { recursive: true, force: true }).catch(() => undefined)
  return { folder, stamp, files: contents.size }
}
