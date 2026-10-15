// Media files on disk (DATA-MODEL §11), written and read on the main thread through
// libuv's file I/O, which doesn't block the event loop.
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { Effect } from "effect"
import { isMediaPath, mediaPath } from "../db/media.ts"

/**
 * Writes a file under its SHA-256, unless it's there already. A temporary file renamed into
 * place, so a crash never leaves half a file under the final name. A file that's there
 * already has its time refreshed, so the sweep treats it as new while its import commits.
 */
export const storeMedia = (dataDir: string, sha256: string, bytes: Uint8Array) =>
  Effect.tryPromise(async () => {
    const path = join(dataDir, mediaPath(sha256))
    const exists = await stat(path).then(
      (info) => info.size === bytes.byteLength,
      () => false
    )
    if (exists) {
      const now = new Date()
      const refreshed = await utimes(path, now, now).then(
        () => true,
        () => false
      )
      if (refreshed) return
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  })

interface SweepOptions {
  /** How old a file must be to go; younger ones may belong to an import in progress. */
  readonly graceMs: number
  /** Hashes an import in this process has written and not yet recorded or given up. */
  readonly pending: { readonly has: (sha256: string) => boolean }
  /** Whether a row names the file, asked again just before it goes. */
  readonly isRecorded: (sha256: string) => Effect.Effect<boolean, unknown>
  /**
   * Runs after a candidate's first checks, and again once it's moved aside; for tests of
   * what happens meanwhile.
   */
  readonly between?: (step: "checked" | "moved aside", path: string) => Effect.Effect<void>
}

const HASH = /^[0-9a-f]{64}$/
/** A file the sweep moved aside: its hash, a random id, and the suffix. */
const SWEPT = /^([0-9a-f]{64})\.[0-9a-f-]{36}\.swept$/

/**
 * Files an import wrote but never recorded, because its transaction failed or the server
 * stopped in between, are written before the rows that name them. This deletes the media
 * files no row names (`recorded` is the list read at the start), once older than the grace
 * period, and leftover temporary files.
 * - An import may record a file while the sweep runs, so a candidate is checked again just
 *   before it goes: not held by an import in progress, not recorded. It's then moved aside,
 *   checked once more, and deleted, or moved back if an import took it meanwhile.
 * - A file moved aside by a sweep that stopped there (the server died) is put back if its
 *   hash is recorded or an import holds it, unless the file is back already; any other is
 *   deleted. Every sweep does this first, the one at startup included.
 * - Links are never followed: only plain folders and files under the media folder, itself
 *   not a link, are looked at, and every path deleted must resolve inside it.
 * Resolves to how many files were deleted.
 */
export const sweepMedia = (dataDir: string, recorded: ReadonlySet<string>, options: SweepOptions) =>
  Effect.gen(function* () {
    const root = resolve(dataDir, "media")
    const kind = (path: string) =>
      Effect.promise(() =>
        lstat(path).then(
          (info) => info,
          () => null
        )
      )
    const rootInfo = yield* kind(root)
    if (rootInfo === null || !rootInfo.isDirectory()) return 0
    const list = (path: string) =>
      Effect.promise(() =>
        readdir(path).then(
          (names) => names,
          () => []
        )
      )
    const cutoff = Date.now() - options.graceMs
    const wanted = (sha256: string | null) =>
      sha256 === null
        ? Effect.succeed(false)
        : Effect.map(options.isRecorded(sha256), (r) => r || options.pending.has(sha256))
    let deleted = 0
    for (const folder of yield* list(root)) {
      const folderPath = join(root, folder)
      if (!/^[0-9a-f]{2}$/.test(folder) || !(yield* kind(folderPath))?.isDirectory()) continue
      for (const name of yield* list(folderPath)) {
        const path = join(folderPath, name)
        const info = yield* kind(path)
        if (info === null || !info.isFile() || !resolve(path).startsWith(root + sep)) continue
        if (name.endsWith(".swept")) {
          const hash = SWEPT.exec(name)?.[1]
          const original = hash === undefined ? null : join(folderPath, hash)
          if (hash !== undefined && original !== null && (recorded.has(hash) || (yield* wanted(hash)))) {
            if ((yield* kind(original)) === null) yield* Effect.promise(() => rename(path, original))
            else yield* Effect.promise(() => rm(path, { force: true }))
          } else {
            yield* Effect.promise(() => rm(path, { force: true }))
            deleted++
          }
          continue
        }
        if (info.mtimeMs > cutoff) continue
        // Derivatives and animation markers belong to the immutable original. Keep them
        // while it is recorded; sweep them with it when its row is gone.
        const sha256 = HASH.test(name)
          ? name
          : (/^([0-9a-f]{64})\.(?:thumb-v1-(?:96|192|384|768)\.webp|animated-v1)$/.exec(name)?.[1] ?? null)
        if (sha256 !== null && (recorded.has(sha256) || options.pending.has(sha256))) continue
        if (options.between) yield* options.between("checked", path)
        if (yield* wanted(sha256)) continue
        const aside = `${path}.${randomUUID()}.swept`
        if (
          !(yield* Effect.promise(() =>
            rename(path, aside).then(
              () => true,
              () => false
            )
          ))
        )
          continue
        if (options.between) yield* options.between("moved aside", aside)
        if (yield* wanted(sha256)) {
          // An import that found the file gone wrote its own copy, which is the same bytes.
          yield* Effect.promise(() => rename(aside, path).catch(() => rm(aside, { force: true })))
          continue
        }
        yield* Effect.promise(() => rm(aside, { force: true }))
        deleted++
      }
    }
    return deleted
  })

/** A stored file's bytes, or undefined if it's missing. Only paths `mediaPath` makes are read. */
export const readMedia = (dataDir: string, path: string) =>
  isMediaPath(path)
    ? Effect.tryPromise(() => readFile(join(dataDir, path))).pipe(
        Effect.tapError((error) => Effect.logWarning(`media file ${path} can't be read`, error)),
        Effect.orElseSucceed(() => undefined)
      )
    : Effect.succeed(undefined)
