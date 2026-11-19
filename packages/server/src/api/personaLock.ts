// RPC handlers for the persona locked to a character (@rp/shared/personaLockApi.ts, DESIGN
// §2.2). They act as the authenticated user; storage enforces ownership (db/personaLocks.ts).
import { CurrentUser } from "@rp/shared/api.ts"
import type { PersonaLockApi } from "@rp/shared/personaLockApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makePersonaLockHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    GetPersonaLock: ({ entityId }) =>
      Effect.flatMap(userId, (id) => reader.GetPersonaLock({ userId: id, entityId })).pipe(internal("GetPersonaLock")),
    SetPersonaLock: (input) =>
      Effect.flatMap(userId, (id) => writer.SetPersonaLock({ ...input, userId: id })).pipe(internal("SetPersonaLock"))
  } satisfies Parameters<typeof PersonaLockApi.of>[0]
})
