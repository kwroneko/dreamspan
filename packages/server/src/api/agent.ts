// The agent RPCs (@rp/shared/agentApi.ts). Storage checks the version is the caller's.
import { type AgentApi } from "@rp/shared/agentApi.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeAgentHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  return {
    GetRolloutSteps: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutSteps({ userId: user.id, versionId })).pipe(
        internal("GetRolloutSteps")
      )
  } satisfies Parameters<typeof AgentApi.of>[0]
})
