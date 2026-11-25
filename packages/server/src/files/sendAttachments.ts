// The Files step of sending a workshop's staged uploads. The writer separately commits the
// message, the final paths and the composer rows in its send transaction.
import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, copyFile, lstat, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ChatId, MessageImages } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound, ServerError } from "@dreamspan/shared/errors.ts"
import { ATTACHMENTS_FOLDER, FILES_TOP, numberedFileName } from "@dreamspan/shared/files.ts"
import { Cause, Effect, Exit } from "effect"
import { AppConfig } from "../config.ts"
import { Reader } from "../db/Database.ts"
import { mediaPath } from "../db/media.ts"
import { accountEnv, prepareAccount } from "./environment.ts"
import { FilePathRefused, openFolder, renameNoReplace, sameFileEntry } from "./safePath.ts"
import { withFileTree } from "./treeLocks.ts"
import { WorkshopFiles } from "./WorkshopFiles.ts"

interface SendAttachments {
  readonly chatId: ChatId
  readonly images?: MessageImages
  readonly imageDraftIds?: readonly string[]
  readonly composer: { readonly draftId: string } | undefined
}

interface Published {
  readonly images?: MessageImages
  readonly publishedAttachments?: ReadonlyArray<{ id: string; path: string; inode: number }>
}

const destination = `${FILES_TOP}/${ATTACHMENTS_FOLDER}`

export const makeAttachmentSend = Effect.gen(function* () {
  const config = yield* AppConfig
  const reader = yield* Reader
  const { quota, changed } = yield* WorkshopFiles
  const dirs = {
    filesDir: config.filesDir || join(config.dataDir, "files"),
    homesDir: join(config.dataDir, "env-home")
  }

  return <A, E, R>(userId: UserId, input: SendAttachments, write: (published: Published) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { images, imageDraftIds: ids, composer } = input
      if (!images?.length || !ids?.length || !composer) return yield* write({})
      const load = reader.GetStagedComposerFiles({ userId, chatId: input.chatId, draftId: composer.draftId, ids })
      if (!(yield* load).length) return yield* write({})

      return yield* withFileTree(
        userId,
        Effect.gen(function* () {
          const files = yield* load
          const byId = new Map(files.map((file) => [file.id, file]))
          const uploads = ids.flatMap((id, index) => {
            const file = byId.get(id)
            return file ? [{ file, image: images[index], index }] : []
          })
          if (uploads.some(({ file, image }) => file.mediaId !== image?.mediaId))
            return yield* new NotFound({ entity: "composer images", id: composer.draftId })
          if (!uploads.length) return yield* write({})
          const bytes = uploads.reduce((sum, { file }) => sum + file.byteSize, 0)
          const fail = (message: string) => new ServerError({ message })
          const fileError = (error: Cause.UnknownError) => {
            if (error.cause instanceof FilePathRefused) return fail(error.cause.message)
            return fail("The attachments couldn't be saved in Files.")
          }
          const env = accountEnv(dirs, userId)
          const reserve = yield* quota
            .check(userId, bytes, "send attachments")
            .pipe(Effect.mapError((error) => fail(error.message)))
          const reservation = quota.hold(userId, "outside-files")
          const landed: Array<{ name: string; info: Stats }> = []
          return yield* Effect.gen(function* () {
            if (!reservation.reserve(bytes, reserve.quotaBytes))
              return yield* fail(quota.overMessage(reserve.usedBytes + bytes, reserve.quotaBytes, "send attachments"))
            const dir = yield* Effect.tryPromise(async () => {
              await prepareAccount(env)
              return openFolder(env.filesRoot, [ATTACHMENTS_FOLDER], {
                create: true,
                onCreated: () => quota.wrote(userId, 4096)
              })
            }).pipe(Effect.mapError(fileError))
            const at = (name: string) => `/proc/self/fd/${dir.fd}/${name}`
            const temporary = `.attachment-${randomUUID()}.rp-tmp`
            reservation.stage(temporary)
            return yield* Effect.gen(function* () {
              const sentImages = [...images]
              const publishedAttachments = []
              for (const { file, image, index } of uploads) {
                const { path, name, inode } = yield* Effect.tryPromise(async () => {
                  try {
                    await copyFile(join(config.dataDir, mediaPath(file.sha256)), at(temporary), constants.COPYFILE_EXCL)
                    await chmod(at(temporary), 0o644)
                    let name = file.name
                    for (let number = 2; ; number++) {
                      try {
                        await renameNoReplace(at(temporary), at(name))
                        break
                      } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                        name = numberedFileName(file.name, number)
                      }
                    }
                    const info = await lstat(at(name))
                    landed.push({ name, info })
                    return { path: `${destination}/${name}`, name, inode: info.ino }
                  } finally {
                    await unlink(at(temporary)).catch(() => undefined)
                  }
                }).pipe(Effect.mapError(fileError))
                sentImages[index] = { ...image!, name, path }
                publishedAttachments.push({ id: file.id, path, inode })
              }
              const result = yield* write({ images: sentImages, publishedAttachments })
              reservation.landed()
              changed(
                userId,
                publishedAttachments.map(({ path }) => path)
              )
              return result
            }).pipe(
              Effect.onExit((exit) =>
                Effect.tryPromise(async () => {
                  try {
                    if (Exit.isFailure(exit))
                      for (const { name, info } of landed) {
                        const current = await lstat(at(name)).catch(() => null)
                        if (sameFileEntry(info, current)) await unlink(at(name))
                      }
                  } finally {
                    await dir.close()
                  }
                }).pipe(
                  Effect.catch((error) => Effect.logWarning("cleaning up a send's attachment files failed", error))
                )
              )
            )
          }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(reservation.release) : Effect.void)))
        }).pipe(Effect.uninterruptible)
      )
    })
})
