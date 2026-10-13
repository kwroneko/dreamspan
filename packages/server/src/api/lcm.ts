import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { internal } from "./internal.ts"

export const makeLcmHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  return {
    GetSummary: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.GetSummary({ userId: user.id, ...params })).pipe(
        internal("GetSummary")
      ),
    EditSummary: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.EditSummary({ userId: user.id, ...params })
        yield* warmth.refreshUser(user.id)
        return result
      }).pipe(internal("EditSummary")),
    SelectSummaryRevision: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.SelectSummaryRevision({ userId: user.id, ...params })
        yield* warmth.refreshUser(user.id)
        return result
      }).pipe(internal("SelectSummaryRevision"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
