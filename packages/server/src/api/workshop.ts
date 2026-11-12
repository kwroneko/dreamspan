import { CurrentUser } from "@rp/shared/api.ts"
import type { WorkshopApi } from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { ExecutionRegistry, toolForKind } from "../execution.ts"
import { foldState } from "@rp/shared/state.ts"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const reader = yield* Reader
  const execution = yield* ExecutionRegistry
  return {
    ListWorkshopCapabilities: ({ chatId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const chat = yield* reader.GetChat({ userId, chatId })
        const profile = execution.chatKinds.get(chat.kind)
        if (!profile?.allowsOutside) return []
        const state = foldState(
          yield* reader.StateEventsAt({ userId, chatId, slotId: chat.activeLeafSlotId, forkId: chat.currentForkId })
        )
        const plan = execution.orchestrationModes.get(profile.planner)?.plan({ state, kind: chat.kind })
        const offered = new Set(
          (plan?.tools ?? []).flatMap((name) => {
            const capability = toolForKind(execution, chat.kind, name)?.capability
            return capability ? [capability] : []
          })
        )
        return execution.workshopCapabilities
          .list()
          .filter((capability) => offered.has(capability.id))
          .sort((a, b) => a.order - b.order)
      }).pipe(internal("ListWorkshopCapabilities")),
    ListRolloutEffects: (input) =>
      Effect.flatMap(CurrentUser, (user) => reader.ListRolloutEffects({ ...input, userId: user.id })).pipe(
        internal("ListRolloutEffects")
      ),
    UndoRolloutEffect: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.UndoRolloutEffect({ ...input, userId: user.id })).pipe(
        internal("UndoRolloutEffect")
      ),
    CreateWorkshop: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.CreateWorkshop({ ...input, userId: user.id })).pipe(
        internal("CreateWorkshop")
      )
  } satisfies Parameters<typeof WorkshopApi.of>[0]
})
