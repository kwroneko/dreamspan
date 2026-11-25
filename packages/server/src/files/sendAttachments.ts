// Prepares workshop uploads outside the mounted Files tree. The send transaction records their
// final paths and publication intents before any live file can be installed.
import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { copyFile, link, lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { ChatId, MessageImages } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound, ServerError } from "@dreamspan/shared/errors.ts"
import { ATTACHMENTS_FOLDER, FILES_TOP, nameOf, nameProblem, numberedFileName } from "@dreamspan/shared/files.ts"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { mediaPath } from "../db/media.ts"
import type { AttachmentPublication, PublishedAttachments } from "../db/ops.ts"
import { accountEnv, prepareAccount } from "./environment.ts"
import { FilePathRefused, openFolder } from "./safePath.ts"
import { withFileTree } from "./treeLocks.ts"
import { WorkshopFiles } from "./WorkshopFiles.ts"

interface SendAttachments {
  readonly chatId: ChatId
  readonly images?: MessageImages
  readonly imageDraftIds?: readonly string[]
  readonly composer: { readonly draftId: string } | undefined
}

interface Prepared {
  readonly images?: MessageImages
  readonly publishedAttachments?: PublishedAttachments
}

const destination = `${FILES_TOP}/${ATTACHMENTS_FOLDER}`
const preparationFolder = ".attachment-publications"
const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`
const missing = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null
  throw error
}

const syncDirectory = async (path: string) => {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

const publications = Effect.gen(function* () {
  const config = yield* AppConfig
  const reader = yield* Reader
  const writer = yield* Writer
  const { quota, changed } = yield* WorkshopFiles
  const dirs = {
    filesDir: config.filesDir || join(config.dataDir, "files"),
    homesDir: join(config.dataDir, "env-home")
  }
  // This directory is beside the account roots, on the Files volume but outside their mounts.
  const staging = join(dirs.filesDir, preparationFolder)
  const drop = (tokens: readonly string[]) =>
    Effect.tryPromise(async () => {
      for (const token of tokens) await unlink(join(staging, token)).catch(missing)
    }).pipe(Effect.catch((error) => Effect.logWarning("cleaning up attachment preparations failed", error)))

  // Under the tree lock. The hard link is the no-overwrite step used by renameNoReplace.
  // Keep the private name until the destination is durable, so a retry can identify its own link.
  const install = (publication: AttachmentPublication) =>
    Effect.tryPromise(async () => {
      const { userId, token, path, device, inode } = publication
      const staged = join(staging, token)
      const prepared = await lstat(staged).catch(missing)
      // Only a completed install removes this name while its database intent is outstanding.
      // The user may already have moved or removed the live file by the time we retry its receipt.
      if (prepared === null) return null
      if (!prepared.isFile() || prepared.dev !== device || prepared.ino !== inode)
        throw new Error(`The private preparation for ${path} changed.`)
      const env = accountEnv(dirs, userId)
      await prepareAccount(env)
      const dir = await openFolder(env.filesRoot, [ATTACHMENTS_FOLDER], {
        create: true,
        onCreated: () => quota.wrote(userId, 4096)
      })
      const target = at(dir, nameOf(path))
      const isOurLink = (info: Stats | null) => info?.dev === device && info.ino === inode
      try {
        try {
          await link(staged, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isOurLink(await lstat(target).catch(missing)))
            throw error
        }
        try {
          await dir.sync()
          await syncDirectory(env.filesRoot)
          await unlink(staged)
        } catch (error) {
          // With the private name still intact, leave a failed install ready for another try.
          if (isOurLink(await lstat(target).catch(missing))) await unlink(target)
          throw error
        }
        await syncDirectory(staging)
        return prepared
      } finally {
        await dir.close()
      }
    })

  const finish = (publication: AttachmentPublication, landed: (info: Stats | null) => void) =>
    Effect.gen(function* () {
      const info = yield* install(publication)
      landed(info)
      changed(publication.userId, [publication.path])
      yield* writer.FinishAttachmentPublication({ token: publication.token })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("completing an accepted attachment publication failed", publication.path, cause)
      )
    )

  const recover = (startup: boolean) =>
    Effect.gen(function* () {
      const pending = yield* reader.ListAttachmentPublications({})
      if (startup) {
        // No requests can be preparing files here yet. An unrecorded copy came from a
        // process that stopped before the send committed or before cleanup of a rejection.
        const kept = new Set(pending.map(({ token }) => token))
        const entries = yield* Effect.tryPromise(() => readdir(staging).catch(missing))
        yield* drop((entries ?? []).filter((name) => /^[0-9a-f-]{36}$/.test(name) && !kept.has(name)))
      }
      for (const userId of new Set(pending.map((row) => row.userId)))
        yield* withFileTree(
          userId,
          Effect.gen(function* () {
            // A send may have finished its own intent since the first read.
            let installed = false
            for (const row of yield* reader.ListAttachmentPublications({ userId }))
              yield* finish(row, (info) => (installed ||= info !== null))
            if (installed) yield* quota.measure(userId, true)
          }).pipe(Effect.uninterruptible)
        )
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("recovering attachment publications failed", cause)))

  return { config, reader, quota, dirs, staging, drop, finish, recover }
})

export const AttachmentPublicationRecovery = Layer.effectDiscard(
  Effect.gen(function* () {
    const { recover } = yield* publications
    yield* recover(true)
    yield* recover(false).pipe(
      Effect.delay(Duration.minutes(1)),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped
    )
  })
)

export const makeAttachmentSend = Effect.gen(function* () {
  const { config, reader, quota, dirs, staging, drop, finish } = yield* publications

  return <A, E, R>(userId: UserId, input: SendAttachments, write: (prepared: Prepared) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { images, imageDraftIds: ids, composer } = input
      if (!images?.length || !ids?.length || !composer) return yield* write({})
      const load = reader.GetStagedComposerFiles({ userId, chatId: input.chatId, draftId: composer.draftId, ids })
      if (!(yield* load).length) return yield* write({})

      return yield* withFileTree(
        userId,
        Effect.gen(function* () {
          const byId = new Map((yield* load).map((file) => [file.id, file]))
          const uploads = ids.flatMap((id, index) => {
            const file = byId.get(id)
            return file ? [{ file, image: images[index], index }] : []
          })
          if (uploads.some(({ file, image }) => file.mediaId !== image?.mediaId))
            return yield* new NotFound({ entity: "composer images", id: composer.draftId })
          if (!uploads.length) return yield* write({})

          const bytes = uploads.reduce((sum, { file }) => sum + file.byteSize, 0)
          const fail = (message: string) => new ServerError({ message })
          const usage = yield* quota
            .check(userId, bytes, "send attachments")
            .pipe(Effect.mapError((error) => fail(error.message)))
          const pending = yield* reader.ListAttachmentPublications({ userId })
          const taken = new Set(pending.map(({ path }) => path))
          const holds = new Map<string, ReturnType<typeof quota.hold>>()
          const tokens: string[] = []
          let acceptance: "unattempted" | "unknown" | "committed" = "unattempted"
          return yield* Effect.gen(function* () {
            const sentImages = [...images]
            const prepared = yield* Effect.tryPromise(async () => {
              const env = accountEnv(dirs, userId)
              await prepareAccount(env)
              await mkdir(staging, { mode: 0o700, recursive: true })
              const privateDir = await openFolder(staging, [])
              try {
                const dir = await openFolder(env.filesRoot, [ATTACHMENTS_FOLDER]).catch(missing)
                try {
                  const device = (await privateDir.stat()).dev
                  if ((dir ? (await dir.stat()).dev : (await lstat(env.filesRoot)).dev) !== device)
                    throw new Error("The account's Files are on another volume from the attachment preparations.")
                  const result = []
                  for (const { file, image, index } of uploads) {
                    let name = file.name
                    for (let number = 2; ; number++) {
                      const problem = nameProblem(name)
                      if (problem) throw new FilePathRefused(problem)
                      const path = `${destination}/${name}`
                      if (!taken.has(path) && (dir === null || (await lstat(at(dir, name)).catch(missing)) === null))
                        break
                      name = numberedFileName(file.name, number)
                    }
                    const path = `${destination}/${name}`
                    taken.add(path)
                    const token = randomUUID()
                    const hold = quota.hold(userId, "outside-files")
                    if (!hold.reserve(file.byteSize, usage.quotaBytes))
                      throw new FilePathRefused(
                        quota.overMessage(usage.usedBytes + bytes, usage.quotaBytes, "send attachments")
                      )
                    holds.set(token, hold)
                    const temporary = at(privateDir, token)
                    await copyFile(join(config.dataDir, mediaPath(file.sha256)), temporary, constants.COPYFILE_EXCL)
                    tokens.push(token)
                    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
                    try {
                      const info = await handle.stat()
                      if (info.size !== file.byteSize) throw new Error("An attachment's stored size changed.")
                      await handle.chmod(0o644)
                      await handle.sync()
                      sentImages[index] = { ...image!, name, path }
                      result.push({ id: file.id, path, inode: info.ino, device, token })
                    } finally {
                      await handle.close()
                    }
                  }
                  await privateDir.sync()
                  await syncDirectory(dirs.filesDir)
                  return result
                } finally {
                  await dir?.close()
                }
              } finally {
                await privateDir.close()
              }
            }).pipe(
              Effect.mapError((error: Cause.UnknownError) =>
                fail(
                  error.cause instanceof FilePathRefused
                    ? error.cause.message
                    : "The attachments couldn't be saved in Files."
                )
              )
            )
            acceptance = "unknown"
            const result = yield* write({ images: sentImages, publishedAttachments: prepared })
            acceptance = "committed"
            for (const { token, path, device, inode } of prepared)
              yield* finish({ userId, token, path, device, inode }, (info) => {
                holds.get(token)?.landed(info ?? undefined)
                holds.delete(token)
              })
            return result
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                for (const hold of holds.values()) hold.release()
                if (acceptance === "unattempted") yield* drop(tokens)
                if (acceptance === "unknown") {
                  // A write can lose its response after committing. Keep the preparations
                  // named by durable intents, or leave them for startup if storage is down.
                  yield* reader.ListAttachmentPublications({ userId }).pipe(
                    Effect.flatMap((rows) => {
                      const kept = new Set(rows.map(({ token }) => token))
                      return drop(tokens.filter((token) => !kept.has(token)))
                    }),
                    Effect.catch((error) =>
                      Effect.logWarning("checking a send's attachment preparations failed", error)
                    )
                  )
                }
              })
            )
          )
        }).pipe(Effect.uninterruptible)
      )
    })
})
