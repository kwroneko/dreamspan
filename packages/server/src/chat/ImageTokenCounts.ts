// Exact image token counts, off the hot path (ARCHITECTURE §6, §15). When the next context
// of an open chat holds images its model hasn't counted (an image was sent, or the model
// changed), the cache-warmth estimate hands them here; each is counted once per content hash,
// model and detail, stored, and the chat's estimate is made again. Sends never wait for it.
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { Context, Effect, FiberSet, Layer } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { readMedia } from "../importer/mediaFiles.ts"
import { Providers } from "../providers/Providers.ts"

export interface UncountedImages {
  readonly connectionId: string
  readonly kind: string
  readonly modelKey: string
  readonly detail: string
  readonly images: ReadonlyArray<{ readonly mediaId: string; readonly sha256: string }>
}

/** How long a failed count, or a model with no counting endpoint, is left alone. */
const RETRY_MS = 10 * 60_000

export class ImageTokenCounts extends Context.Service<
  ImageTokenCounts,
  {
    /** Counts what isn't counted or being counted; `counted` runs after any new count is stored. */
    readonly request: (userId: UserId, pending: UncountedImages, counted: () => void) => Effect.Effect<void>
  }
>()("rp/chat/ImageTokenCounts") {
  static readonly layer = Layer.effect(
    ImageTokenCounts,
    Effect.gen(function* () {
      const providers = yield* Providers
      const reader = yield* Reader
      const writer = yield* Writer
      const config = yield* AppConfig
      const run = yield* FiberSet.runtime(yield* FiberSet.make())()
      const busy = new Set<string>()
      const resting = new Map<string, number>()
      const rests = (key: string) => (resting.get(key) ?? 0) > Date.now()

      const countOne = (userId: UserId, pending: UncountedImages, image: UncountedImages["images"][number]) =>
        Effect.gen(function* () {
          const file = yield* reader.GetMediaFile({ userId, mediaId: image.mediaId })
          const bytes = yield* readMedia(config.dataDir, file.path)
          if (!bytes) return "failed" as const
          const tokens = yield* providers.countImageTokens({
            userId,
            connectionId: pending.connectionId as ConnectionId,
            modelKey: pending.modelKey,
            image: { data: bytes.toString("base64"), mimeType: file.mime },
            detail: pending.detail
          })
          if (tokens === null) return "no-counter" as const
          yield* writer.RecordImageTokenCount({
            userId,
            sha256: image.sha256,
            kind: pending.kind,
            modelKey: pending.modelKey,
            detail: pending.detail,
            tokens
          })
          return "counted" as const
        })

      return ImageTokenCounts.of({
        request: (userId, pending, counted) =>
          Effect.sync(() => {
            const model = `${userId}\n${pending.connectionId}\n${pending.modelKey}`
            if (rests(model)) return
            const todo = pending.images.filter((image) => {
              const key = `${model}\n${pending.detail}\n${image.sha256}`
              if (busy.has(key) || rests(key)) return false
              busy.add(key)
              return true
            })
            if (todo.length === 0) return
            run(
              Effect.gen(function* () {
                let stored = false
                // One at a time: the endpoints have their own rate limits, and nothing waits on this.
                for (const image of todo) {
                  const key = `${model}\n${pending.detail}\n${image.sha256}`
                  const outcome = yield* countOne(userId, pending, image).pipe(
                    Effect.catch((error) =>
                      Effect.as(
                        Effect.logWarning(`counting an image's tokens for ${pending.modelKey} failed`, error),
                        "failed" as const
                      )
                    ),
                    Effect.ensuring(Effect.sync(() => busy.delete(key)))
                  )
                  if (outcome === "counted") stored = true
                  else if (outcome === "failed") resting.set(key, Date.now() + RETRY_MS)
                  else {
                    resting.set(model, Date.now() + RETRY_MS)
                    break
                  }
                }
                if (stored) counted()
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() =>
                    todo.forEach((image) => busy.delete(`${model}\n${pending.detail}\n${image.sha256}`))
                  )
                )
              )
            )
          })
      })
    })
  )
}
