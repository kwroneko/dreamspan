// The request inspector's RPC (@rp/shared/inspectorApi.ts): a version's context as it was
// sent, read from its rollout's snapshot. Storage checks the version is the caller's.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeInspectorHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  return {
    GetRunContext: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RunContext({ userId: user.id, versionId })).pipe(
        internal("GetRunContext")
      ),
    GetVersionMetrics: ({ versionIds }) =>
      Effect.flatMap(CurrentUser, (user) => reader.VersionMetrics({ userId: user.id, versionIds })).pipe(
        internal("GetVersionMetrics")
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
