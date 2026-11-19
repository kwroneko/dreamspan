// The decision-model settings RPCs (@dreamspan/shared/decisionApi.ts). Storage checks the connection
// and the model are the caller's; the points are the engine's registry, so a plugin's show too.
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { DecisionApi } from "@dreamspan/shared/decisionApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { DecisionEngine } from "../decision/engine.ts"
import { internal } from "./internal.ts"

export const makeDecisionHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const engine = yield* Effect.serviceOption(DecisionEngine)
  return {
    ListDecisionPoints: () =>
      Effect.succeed(
        engine._tag === "Some"
          ? engine.value.points.list().map(({ id, label, description, instead, defaultThreshold }) => ({
              id,
              label,
              description,
              ...(instead ? { instead } : {}),
              defaultThreshold
            }))
          : []
      ),
    GetDecisionSettings: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetDecisionSettings({ userId: user.id })).pipe(
        internal("GetDecisionSettings")
      ),
    SetDecisionSettings: ({ connectionId, model, points }) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer.SetDecisionSettings({ userId: user.id, connectionId, model, points })
      ).pipe(internal("SetDecisionSettings"))
  } satisfies Parameters<typeof DecisionApi.of>[0]
})
