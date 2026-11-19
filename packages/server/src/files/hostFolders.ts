// Host folders (spec/FILES-AND-ENVIRONMENT.md §3.7): folders on the server outside Files that an
// admin may choose as a workshop's working folder, under the roots the operator lists in
// HOST_FOLDERS. A folder is named by its real path (no links on the way), opened again by the
// no-follow walk from "/" each time it's used, and checked against the inode it had when chosen.
// Refused whatever the configuration says: "/", system folders, the sandbox's own places,
// anything that contains or is inside the app's data, its Files or its own code, and anything that
// contains the temporary folder the sandbox keeps its run folders in.
import { realpathSync } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, normalize } from "node:path"
import { openFolder } from "./safePath.ts"

/** System folders and the sandbox's own mount points: never a host folder, nor inside one. */
const SYSTEM = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/var/run",
  "/files",
  "/home/user",
  "/app-source"
]
const LIST_MAX = 500

const within = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
const overlaps = (a: string, b: string) => within(a, b) || within(b, a)

/** A folder in the server folder browser. */
interface HostListing {
  /** Null: the list of roots. */
  readonly path: string | null
  /** Where Up goes: a folder, "" for the list of roots, null at the list itself. */
  readonly parent: string | null
  readonly folders: ReadonlyArray<{ readonly name: string; readonly path: string }>
  readonly truncated: boolean
}

export class HostFolderRefusal extends Error {
  override readonly name = "HostFolderRefusal"
}

export interface HostFolders {
  /** The roots in use, real paths; empty when none are configured or all were refused. */
  readonly roots: () => Promise<ReadonlyArray<string>>
  /** A folder an admin may choose: its real path and inode. Fails with HostFolderRefusal. */
  readonly check: (path: string) => Promise<{ readonly path: string; readonly inode: number }>
  /** Whether a path (a folder or a file in one) is still under a root and allowed. */
  readonly allows: (path: string) => Promise<boolean>
  /** The folder browser's listing: the roots for null. */
  readonly list: (path: string | null) => Promise<HostListing>
}

/** The paths a host folder must not overlap, and those it must not contain. */
const appPlaces = (places: ReadonlyArray<string>) => ({
  // The Node install commands get read-only, too.
  overlap: [...places, dirname(dirname(process.execPath))],
  // The sandbox's run folders: a folder inside the temporary folder is fine, one around it isn't.
  around: [tmpdir(), process.env.DREAMSPAN_SANDBOX_RUNTIME ?? ""].filter((place) => place !== "")
})

/**
 * The app's own places a host folder may not overlap: its data, Files and code, the client it
 * serves, and the folders holding its secret files (the key that encrypts connection secrets,
 * the first admin's password) wherever they are configured: the folder named, and the folder of
 * the file it really is when the name is a link (a Docker secret, say).
 */
export const appPlacesOf = (app: {
  readonly dataDir: string
  readonly filesDir: string
  readonly appRoot: string
  readonly clientDist?: string | null
  readonly secretFiles: ReadonlyArray<string | null | undefined>
}): ReadonlyArray<string> => [
  app.dataDir,
  app.filesDir,
  app.appRoot,
  ...(app.clientDist?.trim() ? [app.clientDist.trim()] : []),
  ...app.secretFiles.flatMap((file) => {
    if (!file?.trim()) return []
    const named = file.trim()
    let real: string | null = null
    try {
      real = realpathSync(named)
    } catch {
      // Not there (yet): its named folder is refused all the same.
    }
    return [...new Set([dirname(named), ...(real ? [dirname(real)] : [])])]
  })
]

export const makeHostFolders = (
  configured: ReadonlyArray<string>,
  /** The app's data folder, Files, its code: never a host folder, nor inside or around one. */
  places: ReadonlyArray<string>,
  log: (message: string) => void = () => undefined
): HostFolders => {
  let resolved: Promise<ReadonlyArray<string>> | null = null
  const real = (list: ReadonlyArray<string>) =>
    Promise.all(list.map((place) => realpath(place).catch(() => normalize(place))))
  const forbidden = async () => {
    const { overlap, around } = appPlaces(places)
    return { overlap: await real(overlap), around: await real(around) }
  }
  type Avoid = Awaited<ReturnType<typeof forbidden>>
  const problem = (path: string, avoid: Avoid) => {
    if (path === "/") return "is the whole file system"
    for (const system of SYSTEM) if (overlaps(path, system)) return `overlaps ${system}`
    for (const place of avoid.overlap) if (overlaps(path, place)) return "overlaps the app's own data or code"
    for (const place of avoid.around) if (within(place, path)) return "holds the sandbox's temporary folder"
    return null
  }
  const roots = () =>
    (resolved ??= (async () => {
      const avoid = await forbidden()
      const kept: Array<string> = []
      for (const entry of configured.map((value) => value.trim()).filter(Boolean)) {
        if (!isAbsolute(entry)) {
          log(`HOST_FOLDERS: ${entry} isn't an absolute path; left out`)
          continue
        }
        const real = await realpath(entry).catch(() => null)
        const info = real ? await lstat(real).catch(() => null) : null
        if (!real || !info?.isDirectory()) {
          log(`HOST_FOLDERS: ${entry} isn't a folder; left out`)
          continue
        }
        const why = problem(real, avoid)
        if (why) {
          log(`HOST_FOLDERS: ${entry} ${why}; left out`)
          continue
        }
        if (!kept.includes(real)) kept.push(real)
      }
      return kept
    })())
  const rootOf = async (path: string) => (await roots()).find((root) => within(path, root)) ?? null
  const allows = async (path: string) => {
    if (!isAbsolute(path) || normalize(path) !== path) return false
    return (await rootOf(path)) !== null && problem(path, await forbidden()) === null
  }
  const check = async (path: string) => {
    if (!isAbsolute(path) || normalize(path) !== path || path.length > 4096)
      throw new HostFolderRefusal("Give the folder's full path.")
    if (!(await allows(path)))
      throw new HostFolderRefusal(`${path} isn't in a folder the server's admin allows (HOST_FOLDERS).`)
    // Its real path only: a link on the way could lead anywhere later.
    const real = await realpath(path).catch(() => null)
    if (real === null) throw new HostFolderRefusal(`${path} doesn't exist.`)
    if (real !== path) throw new HostFolderRefusal(`${path} goes through a link. Choose ${real} instead.`)
    const dir = await openFolder("/", path.split("/").filter(Boolean)).catch(() => null)
    if (!dir) throw new HostFolderRefusal(`${path} isn't a folder.`)
    try {
      return { path, inode: (await dir.stat()).ino }
    } finally {
      await dir.close()
    }
  }
  const list = async (path: string | null): Promise<HostListing> => {
    if (path === null) {
      const all = await roots()
      return { path: null, parent: null, folders: all.map((root) => ({ name: root, path: root })), truncated: false }
    }
    await check(path)
    const root = (await rootOf(path))!
    const entries = await readdir(path, { withFileTypes: true })
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
    return {
      path,
      parent: path === root ? "" : dirname(path),
      folders: folders.slice(0, LIST_MAX).map((name) => ({ name, path: `${path}/${name}` })),
      truncated: folders.length > LIST_MAX
    }
  }
  return { roots, check, allows, list }
}
