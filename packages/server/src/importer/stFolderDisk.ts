// Reading an ST data folder from a path on the machine the app runs on (DESIGN §1.4,
// ARCHITECTURE.md §13): listing the files the import reads, and reading one of them, a chat
// in parts cut at line ends as the browser upload sends it. Plain file reads on the main
// thread; parsing stays in the format workers.
import { open, opendir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { classifyStPath, ST_CHAT_PART_BYTES } from "@rp/shared/stFolder.ts"
import { StFolderEntry, StFolderUnreadable } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { defaultLimits } from "../formats/safety.ts"

/** Deep enough for ST's install folder: `<install>/data/<handle>/chats/<card>/<chat>.jsonl`. */
const MAX_DEPTH = 6
/** Directory entries looked at before giving up: a path that isn't an ST folder can be huge. */
const MAX_ENTRIES = 500_000
/** Folders that hold code, never ST data. */
const SKIPPED = new Set(["node_modules", ".git"])
/** How much of a chat's start is read for the parent it names. */
const HEAD_BYTES = 64 * 1024

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
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const header: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!)
    const metadata =
      typeof header === "object" && header !== null ? (header as Record<string, unknown>).chat_metadata : null
    const name =
      typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).main_chat : null
    return typeof name === "string" && name !== "" ? name : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

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
          const batch = found.slice(at, at + 32).map(
            async ({ path, full, chat }) =>
              new StFolderEntry({
                path,
                size: (await stat(full)).size,
                mainChat: chat ? await mainChatOf(full) : null
              })
          )
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

/**
 * One file of an ST user's folder, or the part of a chat file from byte `start`: at most
 * 8 MiB, ending at a line end unless it's the file's end.
 */
export const readStFolderFile = (root: string, path: string, start: number, chat: boolean) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(join(root, path), "r")
      try {
        const { size } = await handle.stat()
        const max = chat ? ST_CHAT_PART_BYTES : defaultLimits.maxFileBytes
        if (!chat && size > max) throw new Refused(`It's larger than ${Math.round(max / 1024 / 1024)} MB.`)
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
        return { bytes, next, last: next >= size }
      } finally {
        await handle.close()
      }
    },
    catch: (error) => unreadable(error instanceof Refused ? error.message : "The file can't be read.")
  })

class Refused extends Error {}
