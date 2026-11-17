// The Files quota's RPCs (filesQuotaApi.ts): an account's own usage, and an admin's view of and
// quota for any account. Measuring and enforcing live in files/quota.ts.
import { CurrentUser } from "@rp/shared/api.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Forbidden, NotFound, ServerError } from "@rp/shared/errors.ts"
import type { FilesQuotaApi, FilesUsage } from "@rp/shared/filesQuotaApi.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import type { Usage } from "../files/quota.ts"

const view = (usage: Usage): FilesUsage => ({
  usedBytes: usage.usedBytes,
  quotaBytes: usage.quotaBytes,
  filesBytes: usage.filesBytes,
  versionsBytes: usage.versionsBytes,
  homeBytes: usage.homeBytes,
  measuredAt: usage.measuredAt,
  over: usage.usedBytes > usage.quotaBytes,
  partial: usage.partial
})

export const makeFilesQuotaHandlers = Effect.gen(function* () {
  const files = yield* WorkshopFiles
  const reader = yield* Reader
  /** The account named, which must exist; another account's only for an admin. */
  const target = (userId: UserId | undefined) =>
    Effect.gen(function* () {
      const actor = yield* CurrentUser
      if (userId === undefined || userId === actor.id) return actor.id
      if (actor.role !== "admin")
        return yield* new Forbidden({ message: "only an admin can see or set another account's quota" })
      const users = yield* reader
        .ListUsers()
        .pipe(Effect.mapError(() => new ServerError({ message: "storage failed" })))
      if (!users.some((user) => user.id === userId)) return yield* new NotFound({ entity: "user", id: userId })
      return userId
    })
  return {
    GetFilesUsage: ({ userId, fresh }) =>
      Effect.gen(function* () {
        const id = yield* target(userId)
        return view(yield* fresh ? files.quota.measure(id) : files.quota.usage(id))
      }),
    SetFilesQuota: ({ userId, quotaBytes }) =>
      Effect.gen(function* () {
        const actor = yield* CurrentUser
        if (actor.role !== "admin") return yield* new Forbidden({ message: "only an admin can set a quota" })
        const id = yield* target(userId)
        return view(
          yield* files.quota
            .setQuota(id, quotaBytes)
            .pipe(Effect.mapError(() => new ServerError({ message: "the quota couldn't be saved" })))
        )
      })
  } satisfies Parameters<typeof FilesQuotaApi.of>[0]
})
