import { CurrentUser } from "@rp/shared/api.ts"
import type { WorkshopApi } from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const reader = yield* Reader
  return {
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
