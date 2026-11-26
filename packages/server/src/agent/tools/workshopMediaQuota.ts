import { Effect } from "effect"
import { QuotaExceeded, type FilesQuota } from "../../files/quota.ts"
import { withFileTree } from "../../files/treeLocks.ts"
import type { ToolContext } from "../tools.ts"

/** Hold the additional content bytes through the writer's transactional quota check and charge. */
export const withWorkshopMediaQuota = <A extends { readonly addedBytes: number }, E>(
  ctx: ToolContext,
  quota: FilesQuota | undefined,
  media: ReadonlyArray<{ readonly sha256: string; readonly byteSize: number }>,
  what: string,
  save: (maxAddedBytes: number) => Effect.Effect<A, E>
) => {
  if (!quota || media.length === 0) return save(quota ? 0 : Number.MAX_SAFE_INTEGER)
  return withFileTree(
    ctx.userId,
    Effect.gen(function* () {
      const requested = media.map(({ sha256, byteSize }) => ({ sha256, byteSize }))
      const adding = yield* ctx.reader.WorkshopImportBytes({ userId: ctx.userId, media: requested })
      const usage = yield* quota.check(ctx.userId, adding, what)
      const reservation = quota.hold(ctx.userId, "outside-files")
      let committed = false
      return yield* Effect.gen(function* () {
        if (!reservation.reserve(adding, usage.quotaBytes))
          return yield* Effect.fail(
            new QuotaExceeded(quota.overMessage(usage.usedBytes + adding, usage.quotaBytes, what))
          )
        const result = yield* save(adding)
        reservation.landed(undefined, result.addedBytes)
        committed = true
        return result
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!committed) reservation.release()
          })
        )
      )
    }).pipe(Effect.uninterruptible)
  )
}
