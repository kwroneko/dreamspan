// Reading an ST data folder from a path on the machine the app runs on (DESIGN §1.4,
// ARCHITECTURE.md §13): listing the files the import reads, and reading one of them, a chat
// in parts cut at line ends as the browser upload sends it. Plain file reads on the main
// thread; parsing stays in the format workers.
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { open, opendir, readdir, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { classifyStPath, ST_CHAT_PART_BYTES } from "@rp/shared/stFolder.ts"
import { ST_HEAD_BYTES, stMainChat } from "@rp/shared/stPlan.ts"
import { FolderListing, StFolderEntry, StFolderUnreadable } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { defaultLimits } from "../formats/safety.ts"

/** Deep enough for ST's install folder: `<install>/data/<handle>/chats/<card>/<chat>.jsonl`. */
const MAX_DEPTH = 8
/** Directory entries looked at before giving up: a path that isn't an ST folder can be huge. */
const MAX_ENTRIES = 500_000
/** Folders that hold code, never ST data. */
const SKIPPED = new Set(["node_modules", ".git"])

const unreadable = (message: string) => new StFolderUnreadable({ message })

/** What the path's tail is to the import, read as `findStRoots` reads it, or null. */
const kindOf = (segments: ReadonlyArray<string>) => {
  for (let start = segments.length - 1; start >= 0; start--) {
    const file = classifyStPath(segments.slice(start).join("/"))
    if (file !== null) return file.kind
  }
  return null
}

/** The chat a branch file names as its parent (`main_chat`), from its first line. */
const mainChatOf = async (file: string) => {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(ST_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, ST_HEAD_BYTES, 0)
    return stMainChat(buffer.subarray(0, bytesRead).toString("utf8"))
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** A file of an ST user's folder as it is now, for reading it again (a chat linked from a report). */
export const statStFolderFile = (root: string, path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(root)) throw new Refused("Enter the folder's full path.")
      const { size, mtimeMs } = await stat(join(root, path))
      return { size, modifiedMs: mtimeMs }
    },
    catch: (error) =>
      unreadable(error instanceof Refused ? error.message : "The file isn't in the folder any more, or can't be read.")
  })

/** The files under `path` that the import reads or lists. Symbolic links inside aren't followed. */
export const scanStFolder = (path: string) =>
  Effect.gen(function* () {
    if (!isAbsolute(path)) return yield* unreadable("Enter the folder's full path.")
    const root = yield* Effect.tryPromise({
      try: async () => {
        const resolved = await realpath(path)
        if (!(await stat(resolved)).isDirectory()) throw new Error("not a folder")
        return resolved
      },
      catch: () => unreadable("There's no folder at that path, or it can't be read.")
    })
    const files = yield* Effect.tryPromise({
      try: async () => {
        const found: Array<{ path: string; full: string; chat: boolean }> = []
        let seen = 0
        const walk = async (dir: string, segments: ReadonlyArray<string>) => {
          for await (const entry of await opendir(dir)) {
            if (++seen > MAX_ENTRIES) throw new TooMany()
            const here = [...segments, entry.name]
            if (entry.isDirectory()) {
              if (here.length < MAX_DEPTH && !SKIPPED.has(entry.name)) await walk(join(dir, entry.name), here)
            } else if (entry.isFile()) {
              const kind = kindOf(here)
              if (kind !== null)
                found.push({
                  path: here.join("/"),
                  full: join(dir, entry.name),
                  chat: kind === "chat" || kind === "group_chat"
                })
            }
          }
        }
        await walk(root, [])
        found.sort((a, b) => a.path.localeCompare(b.path))
        // A few files at a time: an ST folder can have thousands, more than a process may open.
        const entries: Array<StFolderEntry> = []
        for (let at = 0; at < found.length; at += 32) {
          const batch = found.slice(at, at + 32).map(async ({ path, full, chat }) => {
            const { size, mtimeMs } = await stat(full)
            return new StFolderEntry({
              path,
              size,
              modifiedMs: mtimeMs,
              mainChat: chat ? await mainChatOf(full) : null
            })
          })
          entries.push(...(await Promise.all(batch)))
        }
        return entries
      },
      catch: (error) =>
        error instanceof TooMany
          ? unreadable(`That folder has more than ${MAX_ENTRIES.toLocaleString("en")} files. Choose ST's data folder.`)
          : unreadable("Part of that folder can't be read.")
    })
    return { root, files }
  })

class TooMany extends Error {}

/** Subfolders listed in the folder browser; a folder with more says so. */
const MAX_LISTED = 1_000

/**
 * Whether a folder looks like ST's, from the names in it: its install (`server.js` and
 * `data`), its data folder (`default-user`), or one user's folder (`characters` and `chats`).
 */
const looksLikeSt = async (folder: string) => {
  try {
    const names = new Set(await readdir(folder))
    return (
      (names.has("server.js") && names.has("data")) ||
      names.has("default-user") ||
      (names.has("characters") && names.has("chats"))
    )
  } catch {
    return false
  }
}

/** A folder's subfolders, hidden ones left out, for the import page's folder browser; `start` when `path` is null. */
export const listFolder = (path: string | null, start: string) =>
  Effect.tryPromise({
    try: async () => {
      if (path !== null && !isAbsolute(path)) throw new Refused("Enter the folder's full path.")
      const folder = await realpath(path ?? start)
      const names: Array<string> = []
      let truncated = false
      for await (const entry of await opendir(folder)) {
        if (entry.name.startsWith(".") || !entry.isDirectory()) continue
        if (names.length === MAX_LISTED) {
          truncated = true
          break
        }
        names.push(entry.name)
      }
      names.sort((a, b) => a.localeCompare(b))
      const folders = []
      for (let at = 0; at < names.length; at += 32) {
        const batch = names.slice(at, at + 32)
        const marks = await Promise.all(batch.map((name) => looksLikeSt(join(folder, name))))
        folders.push(...batch.map((name, i) => ({ name, st: marks[i]! })))
      }
      const parent = dirname(folder)
      return new FolderListing({ path: folder, parent: parent === folder ? null : parent, folders, truncated })
    },
    catch: (error) =>
      unreadable(error instanceof Refused ? error.message : "There's no folder at that path, or it can't be read.")
  })

/**
 * One file of an ST user's folder, or the part of a chat file from byte `start`: at most
 * 8 MiB, ending at a line end unless it's the file's end.
 */
export const readStFolderFile = (
  root: string,
  path: string,
  seen: { readonly size: number; readonly modifiedMs: number },
  start: number,
  chat: boolean
) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(root)) throw new Refused("Enter the folder's full path.")
      const handle = await open(join(root, path), "r")
      try {
        const { size, mtimeMs, birthtimeMs } = await handle.stat()
        // A chat ST is still writing to: its parts would mix two versions of the file.
        if (size !== seen.size || mtimeMs !== seen.modifiedMs)
          throw new Refused("It changed after the folder was read. Look in the folder again, then import it.")
        const max = chat ? ST_CHAT_PART_BYTES : defaultLimits.maxFileBytes
        if (!chat && size > max) throw new Refused(`It's larger than ${formatByteSize(max)}.`)
        const buffer = Buffer.alloc(Math.max(0, Math.min(max, size - start)))
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, start)
        let bytes: Uint8Array = buffer.subarray(0, bytesRead)
        if (start + bytesRead < size) {
          if (!chat) throw new Refused("It changed while it was read.")
          const end = bytes.lastIndexOf(0x0a)
          if (end < 0) throw new Refused("A message in this chat is larger than 8 MB, which the import can't take.")
          bytes = bytes.subarray(0, end + 1)
        }
        const next = start + bytes.byteLength
        return { bytes, next, last: next >= size, birthtimeMs }
      } finally {
        await handle.close()
      }
    },
    catch: (error) => unreadable(error instanceof Refused ? error.message : "The file can't be read.")
  })

class Refused extends Error {}

/**
 * What a library file is in the library, as `importLibrary` matches an earlier import's file
 * by its bytes. Not a persona's avatar: its import's hash takes in the persona's settings too.
 */
const LIBRARY_KINDS: Partial<Record<string, string>> = {
  card: "card",
  world: "lorebook",
  preset: "preset"
}

/** Above this a file is hashed 1 MiB at a time, so no file holds the main thread for long. */
const WHOLE_HASH_BYTES = 8 * 1024 * 1024

/**
 * A file's sha256. A card of a few MiB is read whole and hashed in a few milliseconds (on a
 * heavily loaded host, faster than streaming it, and no slower for other requests); a larger
 * one (up to 64 MiB) is streamed, so it never holds the main thread for its whole length.
 */
const hashFile = async (path: string, size: number) => {
  const hash = createHash("sha256")
  if (size <= WHOLE_HASH_BYTES) return hash.update(await readFile(path)).digest("hex")
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

const safeSegments = (path: string) =>
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")

/** Whether a chat file holds no message, or one that isn't the user's: ST's greeting-only chat, which the import skips. */
const greetingOnly = (text: string) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  if (lines.length <= 1) return true
  if (lines.length > 2) return false
  try {
    const message: unknown = JSON.parse(lines[1]!)
    return !(typeof message === "object" && message !== null && (message as Record<string, unknown>).is_user === true)
  } catch {
    return false
  }
}

/**
 * For the import page's preview of a folder named by its path (StImportPreview), the files
 * of `paths` (relative to the ST user's folder `prefix` of `root`) no earlier import recorded by path:
 * library files whose bytes an earlier import already holds (`hashes`, `<kind>:<sha256>`,
 * read only for kinds that have any), and chats small enough to read at once that hold only
 * a greeting, which every import skips.
 */
export const previewStFiles = (
  folder: { readonly root: string; readonly prefix: string },
  paths: ReadonlyArray<string>,
  hashes: ReadonlySet<string>
) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(folder.root)) throw new Refused("Enter the folder's full path.")
      if (folder.prefix !== "" && !safeSegments(folder.prefix.replace(/\/$/, "")))
        throw new Refused("That isn't an ST user's folder.")
      const root = join(folder.root, folder.prefix)
      const hashed = new Set([...hashes].map((key) => key.slice(0, key.indexOf(":"))))
      const same: Array<string> = []
      const skipped: Array<string> = []
      const check = async (path: string) => {
        if (!safeSegments(path)) return
        const kind = classifyStPath(path)?.kind
        const library = kind === undefined ? undefined : LIBRARY_KINDS[kind]
        const full = join(root, path)
        if (library !== undefined && hashed.has(library)) {
          const { size } = await stat(full)
          if (size > defaultLimits.maxFileBytes) return
          if (hashes.has(`${library}:${await hashFile(full, size)}`)) same.push(path)
        } else if (kind === "chat" || kind === "group_chat") {
          const { size } = await stat(full)
          if (size <= ST_HEAD_BYTES && greetingOnly(await readFile(full, "utf8"))) skipped.push(path)
        }
      }
      // A few files at a time, as the scan reads them.
      for (let at = 0; at < paths.length; at += 16)
        await Promise.all(paths.slice(at, at + 16).map((path) => check(path).catch(() => undefined)))
      return { same, skipped }
    },
    catch: (error) => unreadable(error instanceof Refused ? error.message : "The folder can't be read.")
  })
