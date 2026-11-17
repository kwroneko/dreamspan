// An account's environment (spec/FILES-AND-ENVIRONMENT.md §1.1, §3.6): its Files at
// FILES_DIR/<userId>, seen as /files in the sandbox and by the file tools, and its home folder at
// <DATA_DIR>/env-home/<userId>, seen as /home/user by commands only. Separation between accounts
// is by what is mounted, computed here from the user id, never from a path the model wrote.
import { mkdir } from "node:fs/promises"
import { join, posix } from "node:path"
import { FilePathRefused, listFolder, segmentsOf } from "./safePath.ts"
import type { SandboxMount } from "../sandbox/registry.ts"

export const FILES_MOUNT = "/files"
export const HOME_MOUNT = "/home/user"

export interface AccountEnv {
  readonly userId: string
  /** The account's Files on the host. */
  readonly filesRoot: string
  /** Its home folder for commands on the host. */
  readonly home: string
}

export const accountEnv = (
  dirs: { readonly filesDir: string; readonly homesDir: string },
  userId: string
): AccountEnv => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Unexpected user id.")
  return { userId, filesRoot: join(dirs.filesDir, userId), home: join(dirs.homesDir, userId) }
}

/** Makes the account's folders (owner-only), idempotent. */
export const prepareAccount = async (env: AccountEnv) => {
  await mkdir(env.filesRoot, { recursive: true, mode: 0o700 })
  await mkdir(env.home, { recursive: true, mode: 0o700 })
}

export const accountMounts = (env: AccountEnv): ReadonlyArray<SandboxMount> => [
  { source: env.filesRoot, target: FILES_MOUNT, writable: true },
  { source: env.home, target: HOME_MOUNT, writable: true }
]

/**
 * A file tool's path, relative to the run's directory or absolute, as a path under /files and
 * its components. `..` is resolved by name first, so it can never climb above /files; links
 * are then refused component by component by the walk (safePath.ts).
 */
export const resolveFilesPath = (input: string, cwd: string) => {
  const raw = input.trim()
  if (raw.startsWith("~"))
    throw new FilePathRefused("The file tools work in your files (/files). Use bash for your home folder.")
  const base = cwd === FILES_MOUNT || cwd.startsWith(`${FILES_MOUNT}/`) ? cwd : FILES_MOUNT
  const full = posix.resolve(base, raw === "" ? "." : raw)
  if (full !== FILES_MOUNT && !full.startsWith(`${FILES_MOUNT}/`))
    throw new FilePathRefused(`${full} is outside your files (/files). Use bash for other places.`)
  return { full, segments: segmentsOf(full.slice(FILES_MOUNT.length)) }
}

/** What a scan records of one entry: enough to tell a change (§7.2). */
interface Seen {
  readonly kind: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

/** Folders a scan doesn't look into (§7.2). */
const SCAN_SKIPS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".cache"
])

export interface Scan {
  readonly entries: ReadonlyMap<string, Seen>
  /** The budget ran out: the list is partial. */
  readonly partial: boolean
}

/**
 * The account's tree as size, times and inode per path, within a budget. Each folder is opened
 * by the no-follow walk, so a link swapped in for a folder is never listed through.
 */
export const scanTree = async (root: string, budgetMs = 2000, maxEntries = 50_000): Promise<Scan> => {
  const entries = new Map<string, Seen>()
  const deadline = Date.now() + budgetMs
  const queue: Array<ReadonlyArray<string>> = [[]]
  while (queue.length) {
    const segments = queue.shift()!
    if (Date.now() > deadline || entries.size >= maxEntries) return { entries, partial: true }
    const listed = await listFolder(root, segments, maxEntries).catch(() => null)
    if (!listed) continue
    for (const entry of listed.entries) {
      const path = [...segments, entry.name].join("/")
      entries.set(path, {
        kind: entry.kind,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        ino: entry.ino
      })
      if (entry.kind === "folder" && !SCAN_SKIPS.has(entry.name)) queue.push([...segments, entry.name])
    }
    if (listed.more) return { entries, partial: true }
  }
  return { entries, partial: false }
}

export interface TreeChanges {
  readonly changed: ReadonlyArray<string>
  readonly created: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
  readonly partial: boolean
}

/** Files (not folders) that differ between two scans. */
export const diffScans = (before: Scan, after: Scan): TreeChanges => {
  const changed: Array<string> = []
  const created: Array<string> = []
  const deleted: Array<string> = []
  for (const [path, now] of after.entries) {
    if (now.kind === "folder") continue
    const was = before.entries.get(path)
    if (!was) created.push(path)
    else if (
      was.kind !== now.kind ||
      was.size !== now.size ||
      was.mtimeMs !== now.mtimeMs ||
      was.ctimeMs !== now.ctimeMs ||
      was.ino !== now.ino
    )
      changed.push(path)
  }
  for (const [path, was] of before.entries)
    if (was.kind !== "folder" && !after.entries.has(path) && !after.partial) deleted.push(path)
  return { changed, created, deleted, partial: before.partial || after.partial }
}
