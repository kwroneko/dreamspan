// The app's own access to an account's files (spec/FILES-AND-ENVIRONMENT.md §1.1). Commands can
// plant links, FIFOs and devices in the tree; a link such as `x -> ../../secret.key` would point
// the app's process at its data. So the app never follows one: every access walks the path a
// component at a time from the account's root, opening each folder with O_DIRECTORY|O_NOFOLLOW
// and the next name through /proc/self/fd/<fd>/<name>. The final file is opened with
// O_NOFOLLOW|O_NONBLOCK and refused unless fstat says it is a regular file. Writes go to a fresh
// name in the opened folder and are renamed over the target, which replaces a link rather than
// following it. Main-thread async file I/O only; no SQLite. Linux (procfs) only.
import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, rename, unlink, mkdir, type FileHandle } from "node:fs/promises"
import { randomBytes } from "node:crypto"

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants

export class FilePathRefused extends Error {}

const NAME_MAX = 255
const PATH_MAX = 4096

/** A path's components below the root, checked: no empty, `.`, `..` or NUL, within the limits. */
export const segmentsOf = (relative: string): ReadonlyArray<string> => {
  if (Buffer.byteLength(relative) > PATH_MAX) throw new FilePathRefused("That path is too long.")
  const parts = relative.split("/").filter((part) => part !== "")
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0"))
      throw new FilePathRefused("Paths can't contain “.”, “..” or NUL.")
    if (Buffer.byteLength(part) > NAME_MAX) throw new FilePathRefused(`The name “${part.slice(0, 40)}…” is too long.`)
  }
  return parts
}

const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`

const refuseLinks = (error: unknown, name: string): never => {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "ELOOP" || code === "ENOTDIR")
    throw new FilePathRefused(`“${name}” is a link or not a folder. The app doesn't follow links; use bash for it.`)
  throw error
}

/**
 * Opens the folder at `segments` under `root` without following any link. `create`: missing
 * folders are made on the way (mode 0700 for the root's own children is the caller's choice).
 */
export const openFolder = async (
  root: string,
  segments: ReadonlyArray<string>,
  options: { readonly create?: boolean } = {}
): Promise<FileHandle> => {
  let dir = await open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  try {
    for (const name of segments) {
      let next: FileHandle
      try {
        next = await open(at(dir, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.create) refuseLinks(error, name)
        await mkdir(at(dir, name), { mode: 0o755 }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e
        })
        next = await open(at(dir, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch((e) => refuseLinks(e, name))
      }
      await dir.close()
      dir = next
    }
    return dir
  } catch (error) {
    await dir.close().catch(() => undefined)
    throw error
  }
}

const split = (segments: ReadonlyArray<string>) => {
  if (segments.length === 0) throw new FilePathRefused("Name a file, not the top folder.")
  return { parent: segments.slice(0, -1), name: segments.at(-1)! }
}

/** What is at a path, without following a link there; null: nothing. */
export const statPath = async (root: string, segments: ReadonlyArray<string>): Promise<Stats | null> => {
  if (segments.length === 0) return lstat(root)
  const { parent, name } = split(segments)
  let dir: FileHandle
  try {
    dir = await openFolder(root, parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    return await lstat(at(dir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
  } finally {
    await dir.close()
  }
}

type EntryKind = "file" | "folder" | "link" | "other"
const kindOf = (info: Stats): EntryKind =>
  info.isFile() ? "file" : info.isDirectory() ? "folder" : info.isSymbolicLink() ? "link" : "other"

/** A regular file's bytes, at most `maxBytes`; links, FIFOs and devices are refused. */
export const readRegularFile = async (
  root: string,
  segments: ReadonlyArray<string>,
  maxBytes: number
): Promise<{ readonly bytes: Buffer; readonly info: Stats; readonly truncated: boolean }> => {
  const { parent, name } = split(segments)
  const dir = await openFolder(root, parent)
  try {
    const file = await open(at(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch((e) => refuseLinks(e, name))
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new FilePathRefused(`“${name}” isn't a regular file.`)
      const length = Math.min(info.size, maxBytes)
      const bytes = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await file.read(bytes, read, length - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return { bytes: bytes.subarray(0, read), info, truncated: info.size > read }
    } finally {
      await file.close()
    }
  } finally {
    await dir.close()
  }
}

/**
 * Writes `bytes` as the file at `segments`: a fresh name in the opened folder, renamed over the
 * target. A folder there is refused; a link there is replaced, never followed.
 */
export const writeRegularFile = async (
  root: string,
  segments: ReadonlyArray<string>,
  bytes: Uint8Array,
  options: { readonly createFolders?: boolean } = {}
): Promise<Stats> => {
  const { parent, name } = split(segments)
  const dir = await openFolder(root, parent, { create: options.createFolders === true })
  try {
    const existing = await lstat(at(dir, name)).catch(() => null)
    if (existing?.isDirectory()) throw new FilePathRefused(`“${name}” is a folder.`)
    const temporary = `.${name.slice(0, 200)}.${randomBytes(6).toString("hex")}.rp-tmp`
    const file = await open(at(dir, temporary), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, existing?.mode ?? 0o644)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await rename(at(dir, temporary), at(dir, name))
    } catch (error) {
      await unlink(at(dir, temporary)).catch(() => undefined)
      throw error
    }
    return await lstat(at(dir, name))
  } finally {
    await dir.close()
  }
}

/** Removes the regular file (or link) at `segments`; never a folder's contents. */
export const removeFile = async (root: string, segments: ReadonlyArray<string>) => {
  const { parent, name } = split(segments)
  const dir = await openFolder(root, parent)
  try {
    await unlink(at(dir, name))
  } finally {
    await dir.close()
  }
}

/** Removes an empty folder; used to put back folders an undone creation made. */
export interface Entry {
  readonly name: string
  readonly kind: EntryKind
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

/** A folder's entries, each described without following links, at most `limit`. */
export const listFolder = async (
  root: string,
  segments: ReadonlyArray<string>,
  limit: number
): Promise<{ readonly entries: ReadonlyArray<Entry>; readonly more: boolean }> => {
  const dir = await openFolder(root, segments)
  try {
    const names = (await readdir(`/proc/self/fd/${dir.fd}`)).sort((a, b) => a.localeCompare(b))
    const entries: Array<Entry> = []
    for (const name of names.slice(0, limit)) {
      const info = await lstat(at(dir, name)).catch(() => null)
      if (info)
        entries.push({
          name,
          kind: kindOf(info),
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          ino: info.ino
        })
    }
    return { entries, more: names.length > limit }
  } finally {
    await dir.close()
  }
}
