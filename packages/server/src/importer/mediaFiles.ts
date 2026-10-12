// Media files on disk (DATA-MODEL §11), written and read on the main thread through
// libuv's file I/O, which doesn't block the event loop.
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { isMediaPath, mediaPath } from "../db/media.ts"

/**
 * Writes a file under its SHA-256, unless it's there already. A temporary file renamed into
 * place, so a crash never leaves half a file under the final name.
 */
export const storeMedia = (dataDir: string, sha256: string, bytes: Uint8Array) =>
  Effect.tryPromise(async () => {
    const path = join(dataDir, mediaPath(sha256))
    const exists = await stat(path).then(
      (info) => info.size === bytes.byteLength,
      () => false
    )
    if (exists) return
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  })

/**
 * Files an import wrote but never recorded, because its transaction failed or the server
 * stopped in between, are written before the rows that name them. Files no row names are
 * deleted once they're older than `graceMs`, so an import in progress keeps its own.
 * Leftover temporary files go the same way. Resolves to how many were deleted.
 */
export const sweepMedia = (dataDir: string, recorded: ReadonlySet<string>, graceMs: number) =>
  Effect.tryPromise(async () => {
    const root = join(dataDir, "media")
    const folders = await readdir(root).catch(() => [])
    const cutoff = Date.now() - graceMs
    let deleted = 0
    for (const folder of folders.filter((name) => /^[0-9a-f]{2}$/.test(name))) {
      for (const name of await readdir(join(root, folder))) {
        const kept = /^[0-9a-f]{64}$/.test(name) && recorded.has(name)
        const path = join(root, folder, name)
        if (kept || (await stat(path)).mtimeMs > cutoff) continue
        await rm(path, { force: true })
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
