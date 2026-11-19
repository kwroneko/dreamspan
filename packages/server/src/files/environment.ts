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
/** Where folders other accounts shared with this one appear (§1.4). */
export const SHARED_MOUNT = "/files/Shared"
/** The app's own source for the running version, read-only (§3.6, files/appSource.ts). */
const APP_SOURCE_MOUNT = "/app-source"

/** A folder the file tools reach: its path for the agent, where it is on the host, and whether they may change it. */
export interface ToolRoot {
  readonly mount: string
  readonly hostRoot: string
  readonly writable: boolean
  /** The folder's components below `hostRoot` (a folder shared from another account's Files). */
  readonly base?: ReadonlyArray<string>
  /** A folder on the server outside Files (§3.7): no quota. */
  readonly host?: true
}

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

/** What a command's sandbox binds: the account's Files and home, and the app's source read-only when it's ready. */
export const accountMounts = (env: AccountEnv, appSource: string | null = null): ReadonlyArray<SandboxMount> => [
  { source: env.filesRoot, target: FILES_MOUNT, writable: true },
  { source: env.home, target: HOME_MOUNT, writable: true },
  ...(appSource ? [{ source: appSource, target: APP_SOURCE_MOUNT, writable: false }] : [])
]

/** The folders the file tools reach for this account: its Files, then the app's source (read-only). */
export const toolRoots = (env: AccountEnv, appSource: string | null = null): ReadonlyArray<ToolRoot> => [
  { mount: FILES_MOUNT, hostRoot: env.filesRoot, writable: true },
  ...(appSource ? [{ mount: APP_SOURCE_MOUNT, hostRoot: appSource, writable: false }] : [])
]

const within = (path: string, mount: string) => path === mount || path.startsWith(`${mount}/`)

/**
 * A file tool's path, relative to the run's directory or absolute, in one of `roots` (the
 * deepest that holds it), with its components below that root. `..` is resolved by name first,
 * so it can never climb out of a root; links are then refused component by component by the
 * walk (safePath.ts). A run's directory outside every root (a command's `cd /tmp`) resolves
 * relative paths from the first root.
 */
export const resolveToolPath = (input: string, cwd: string, roots: ReadonlyArray<ToolRoot>) => {
  const raw = input.trim()
  if (raw.startsWith("~"))
    throw new FilePathRefused("The file tools work in your files (/files). Use bash for your home folder.")
  const deepest = (path: string) =>
    roots.filter((root) => within(path, root.mount)).sort((a, b) => b.mount.length - a.mount.length)[0]
  const base = deepest(cwd) ? cwd : roots[0]!.mount
  const full = posix.resolve(base, raw === "" ? "." : raw)
  const root = deepest(full)
  if (!root)
    throw new FilePathRefused(
      `${full} is outside your files (${roots.map((r) => r.mount).join(", ")}). Use bash for other places.`
    )
  return { full, root, segments: [...(root.base ?? []), ...segmentsOf(full.slice(root.mount.length))] }
}

/**
 * A file tool's path, relative to the run's directory or absolute, as a path under /files and
 * its components. `..` is resolved by name first, so it can never climb above /files; links
 * are then refused component by component by the walk (safePath.ts).
 */
export const resolveFilesPath = (input: string, cwd: string) => {
  const { full, segments } = resolveToolPath(input, cwd, [{ mount: FILES_MOUNT, hostRoot: "", writable: true }])
  return { full, segments }
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
