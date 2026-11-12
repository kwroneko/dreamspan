import { CurrentUser } from "@rp/shared/api.ts"
import type { WorkshopApi } from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeWorkshopHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  return {
    CreateWorkshop: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.CreateWorkshop({ ...input, userId: user.id })).pipe(
        internal("CreateWorkshop")
      )
  } satisfies Parameters<typeof WorkshopApi.of>[0]
})
