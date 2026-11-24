// Files in the bin (spec/FILES-AND-ENVIRONMENT.md §1.3): deleting in the app moves a file or folder
// to `FILES_DIR/.bin/<userId>/<itemId>/<name>`, outside the tree commands see, with a `bin_items`
// row of kind `file`. The row is written first and the content moved after, so a folder under the
// bin without a row is always left over (a purge, an eviction, a failed move) and the sweep removes
// it. Restore moves it back to its path, or to "name (restored)" when that is taken, then forgets
// the row. Everything on disk goes through descriptors opened without following links.
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rmdir, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import { Cause, Effect, Semaphore } from "effect"
import type { Reader, Writer } from "../db/Database.ts"
import { resolveFilesPath } from "./environment.ts"
import { measureBin, measureTree, type FilesQuota } from "./quota.ts"
import { FilePathRefused, openFolder, removeTreeAt, renameNoReplace } from "./safePath.ts"

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = constants

const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`

/** The bin's folder name under FILES_DIR: never an account's (ids are plain names without a dot). */
export const BIN_FOLDER = ".bin"

/** "report (restored).pdf" for "report.pdf": the name a restore takes when the old one is taken (§1.3). */
const restoredName = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? `${name.slice(0, dot)} (restored)${name.slice(dot)}` : `${name} (restored)`
}

/** Restores tried at most per item before the name counts as taken. */
const RESTORE_NAME_TRIES = 10_000

/** The names a restore tries in turn: its own, "name (restored)", then "name (restored) (2)" on. */
function* restoreNames(name: string): Generator<string> {
  yield name
  const restored = restoredName(name)
  yield restored
  // As keepBothName numbers a taken name.
  const dot = restored.lastIndexOf(".")
  const stem = dot > 0 ? restored.slice(0, dot) : restored
  const ext = dot > 0 ? restored.slice(dot) : ""
  for (let n = 2; n < RESTORE_NAME_TRIES; n++) yield `${stem} (${n})${ext}`
}

export class BinContentGone extends Error {}

export interface FilesBinDeps {
  readonly filesDir: string
  /** The account's tree on the host. */
  readonly rootOf: (userId: string) => string
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly quota: FilesQuota
}

export const makeFilesBin = (deps: FilesBinDeps) => {
  const binRoot = (userId: string) => join(deps.filesDir, BIN_FOLDER, userId)
  /** One bin change at a time per account, across the row and the files on disk. */
  const queues = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>()
  const serial = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const entry = queues.get(userId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
      queues.set(userId, entry)
      entry.users++
      return entry.lock.withPermit(effect.pipe(Effect.uninterruptible)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--entry.users === 0) queues.delete(userId)
          })
        )
      )
    })

  const openBin = async (userId: string) => {
    await mkdir(binRoot(userId), { recursive: true, mode: 0o700 })
    return open(binRoot(userId), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  }

  /**
   * Moves the entry at `segments` of the account's tree `root` to the bin. `full` is its path as
   * the app shows it (`/files/…`). Returns the new item.
   */
  const toBin = (
    userId: string,
    root: string,
    segments: ReadonlyArray<string>,
    full: string,
    /** Who deleted it, when not the owner of the tree (a folder shared with them). */
    actor?: { readonly userId: string; readonly handle: string }
  ): Effect.Effect<BinItem, unknown> =>
    Effect.gen(function* () {
      if (segments.length === 0) return yield* Effect.fail(new FilePathRefused("The top folder can't be deleted."))
      const name = segments.at(-1)!
      const source = yield* Effect.tryPromise(() => openFolder(root, segments.slice(0, -1)))
      return yield* Effect.gen(function* () {
        const info = yield* Effect.tryPromise(() => lstat(at(source, name)))
        const entryKind = info.isFile()
          ? "file"
          : info.isDirectory()
            ? "folder"
            : info.isSymbolicLink()
              ? "link"
              : "other"
        const byteSize = info.isDirectory()
          ? (yield* Effect.promise(() => measureTree(at(source, name)))).bytes
          : info.isFile()
            ? info.size
            : 0
        const itemId = uuidv7()
        const item = yield* deps.writer.BinFile({
          userId: userId as never,
          itemId,
          path: full,
          name,
          entryKind,
          byteSize,
          ...(actor ? { actor: { userId: actor.userId as never, handle: actor.handle } } : {})
        })
        yield* Effect.tryPromise(async () => {
          const bin = await openBin(userId)
          try {
            await mkdir(at(bin, itemId), { mode: 0o700 })
            const holder = await open(at(bin, itemId), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            try {
              await rename(at(source, name), at(holder, name))
            } catch (error) {
              await holder.close()
              await rmdir(at(bin, itemId)).catch(() => undefined)
              throw error
            }
            await holder.close()
          } finally {
            await bin.close()
          }
        }).pipe(
          Effect.tapError(() => deps.writer.ForgetFileBinItem({ userId: userId as never, itemId }).pipe(Effect.ignore))
        )
        return item
      }).pipe(Effect.ensuring(Effect.promise(() => source.close())))
    })

  /**
   * Puts an item back at its path (missing folders made), or at "name (restored)" when that's
   * taken. Fails with BinContentGone when its content isn't there any more (the row then goes).
   */
  const restore = (
    userId: string,
    itemId: string
  ): Effect.Effect<{ readonly item: BinItem; readonly path: string }, unknown> =>
    serial(
      userId,
      Effect.gen(function* () {
        const root = deps.rootOf(userId)
        yield* Effect.promise(() => mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined))
        const item = yield* deps.reader.FileBinItem({ userId: userId as never, itemId })
        const { segments } = resolveFilesPath(item.path, FILES_TOP)
        if (segments.length === 0)
          return yield* Effect.fail(new FilePathRefused("That item has no place to go back to."))
        const placed = yield* Effect.tryPromise(async () => {
          const bin = await openBin(userId)
          try {
            let holder: FileHandle
            try {
              holder = await open(at(bin, itemId), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            } catch {
              throw new BinContentGone("Its content is gone from the bin.")
            }
            try {
              if (!(await lstat(at(holder, item.name)).catch(() => null)))
                throw new BinContentGone("Its content is gone from the bin.")
              const parent = segments.slice(0, -1)
              const target = await openFolder(root, parent, { create: true })
              try {
                // Each name is tried by a rename that never replaces (renameNoReplace), so
                // whatever a command makes there meanwhile stays; a taken one goes to the next.
                for (const name of restoreNames(segments.at(-1)!)) {
                  try {
                    await renameNoReplace(at(holder, item.name), at(target, name))
                    return [...parent, name]
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                  }
                }
                throw Object.assign(new Error("every restored name is taken"), { code: "EEXIST" })
              } finally {
                await target.close()
              }
            } finally {
              await holder.close()
            }
          } finally {
            await rmdir(at(bin, itemId)).catch(() => undefined)
            await bin.close()
          }
        }).pipe(
          Effect.tapError((error) =>
            Cause.isUnknownError(error) && error.cause instanceof BinContentGone
              ? deps.writer.ForgetFileBinItem({ userId: userId as never, itemId }).pipe(Effect.ignore)
              : Effect.void
          )
        )
        const restored: BinItem = yield* deps.writer.ForgetFileBinItem({ userId: userId as never, itemId })
        return { item: restored, path: `${FILES_TOP}/${placed.join("/")}` }
      })
    )

  /**
   * Removes the content of items no longer in the bin (purged, emptied or evicted), one account's
   * or every account's. The folders are listed before the rows are read: a row is written before
   * its folder, so a folder listed first and missing from the rows read after is left over.
   * Returns the bytes freed.
   */
  const sweep = (userId?: string): Effect.Effect<number> =>
    Effect.gen(function* () {
      const users =
        userId !== undefined
          ? [userId]
          : yield* Effect.promise(() =>
              readdir(join(deps.filesDir, BIN_FOLDER)).catch(() => [] as ReadonlyArray<string>)
            )
      let freed = 0
      for (const user of users) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(user)) continue
        const bytes = yield* serial(
          user,
          Effect.tryPromise(async () => {
            const bin = await open(binRoot(user), O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(() => null)
            if (!bin) return 0
            try {
              const folders = await readdir(`/proc/self/fd/${bin.fd}`)
              if (folders.length === 0) return 0
              const kept = new Set(await Effect.runPromise(deps.reader.FileBinItemIds({ userId: user as never })))
              let removed = 0
              for (const folder of folders) {
                if (kept.has(folder)) continue
                // What removing it frees for sure: a file linked elsewhere frees nothing.
                const size = (await measureBin(at(bin, folder), undefined, undefined, true, undefined, false)).bytes
                await removeTreeAt(bin, folder)
                removed += size
              }
              return removed
            } finally {
              await bin.close()
            }
          })
        ).pipe(
          Effect.catchCause((cause) => Effect.as(Effect.logWarning(`emptying files from the bin failed`, cause), 0))
        )
        if (bytes > 0) deps.quota.freed(user, bytes)
        freed += bytes
      }
      return freed
    })

  return { binRoot, toBin, restore, serial, sweep }
}

export type FilesBin = ReturnType<typeof makeFilesBin>
