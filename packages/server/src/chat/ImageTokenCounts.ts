// Exact image token counts, off the hot path (ARCHITECTURE §6, §15). When the next context
// of an open chat holds images its model hasn't counted (an image was sent, or the model
// changed), the cache-warmth estimate hands them here; each is counted once per content hash,
// model and detail, stored, and the chat's estimate is made again. Sends never wait for it.
// A provider's counting endpoint gets an image only where the user chose one in the chat
// connection's Token counts setting (owner, 2026-11-02: "NEVER send anything to providers users
// didn't actually choose to"; DESIGN §11). Otherwise only a local counter can count, and the
// estimate keeps its formula, calibration or unknown basis.
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { Context, Effect, FiberSet, Layer, Semaphore } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { countingVia } from "../db/tokenCounting.ts"
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
      const gate = yield* Semaphore.make(1)
      const busy = new Set<string>()
      const resting = new Map<string, number>()
      const rests = (key: string) => (resting.get(key) ?? 0) > Date.now()

      const countOne = (
        userId: UserId,
        pending: UncountedImages,
        via: ConnectionId | null,
        image: UncountedImages["images"][number]
      ) =>
        Effect.gen(function* () {
          const cached = yield* reader.GetImageTokenCount({
            userId,
            sha256: image.sha256,
            kind: pending.kind,
            modelKey: pending.modelKey,
            detail: pending.detail
          })
          if (cached !== null && cached > 0) return "counted" as const
          const file = yield* reader.GetMediaFile({ userId, mediaId: image.mediaId })
          const bytes = yield* readMedia(config.dataDir, file.path)
          if (!bytes) return "failed" as const
          const tokens = yield* providers.countImageTokens({
            userId,
            connectionId: pending.connectionId as ConnectionId,
            modelKey: pending.modelKey,
            image: { data: bytes.toString("base64"), mimeType: file.mime },
            detail: pending.detail,
            via
          })
          if (tokens === null) return "no-counter" as const
          if (!Number.isSafeInteger(tokens) || tokens <= 0) return "failed" as const
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
          Effect.gen(function* () {
            const via = countingVia(
              yield* reader.GetTokenCounting({ userId }).pipe(Effect.orElseSucceed(() => [])),
              pending.connectionId
            )
            for (const [key, until] of resting) if (until <= Date.now()) resting.delete(key)
            if (resting.size > 4096) return
            const model = `${userId}\n${pending.kind}\n${pending.modelKey}`
            // What failed, or had nothing to count it, rests apart for each way of counting: a
            // choice made in the connection's settings is tried at once.
            const way = `${model}\n${via ?? "local"}`
            if (rests(way)) return
            const todo = pending.images.filter((image) => {
              const key = `${model}\n${pending.detail}\n${image.sha256}`
              if (busy.size >= 128 || busy.has(key) || rests(`${way}\n${pending.detail}\n${image.sha256}`)) return false
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
                  const outcome = yield* Effect.suspend(() =>
                    rests(way) ? Effect.succeed("no-counter" as const) : countOne(userId, pending, via, image)
                  ).pipe(
                    Effect.timeout("30 seconds"),
                    gate.withPermits(1),
                    Effect.catch((error) =>
                      Effect.as(
                        Effect.logWarning(`counting an image's tokens for ${pending.modelKey} failed`, error),
                        "failed" as const
                      )
                    ),
                    Effect.ensuring(Effect.sync(() => busy.delete(key)))
                  )
                  if (outcome === "counted") stored = true
                  else if (outcome === "failed")
                    resting.set(`${way}\n${pending.detail}\n${image.sha256}`, Date.now() + RETRY_MS)
                  else {
                    resting.set(way, Date.now() + RETRY_MS)
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
