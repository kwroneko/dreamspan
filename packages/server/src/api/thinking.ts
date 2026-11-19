// Hiding a version's thinking from the model (@dreamspan/shared/thinkingApi.ts). Like hiding a
// message, it's an edit: it changes what's sent next and starts nothing.
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { ForkId, ThinkingPart, VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeThinkingHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  return {
    SetThinkingHidden: ({
      versionId,
      part,
      forkId,
      hidden
    }: {
      readonly versionId: VersionId
      readonly part: ThinkingPart
      readonly forkId?: ForkId | null
      readonly hidden: boolean
    }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const written = yield* writer.SetThinkingHidden({ userId, versionId, part, forkId: forkId ?? null, hidden })
        const { chatId, entry } = yield* reader.GetSlot({ userId, slotId: written.slotId, forkId: written.forkId })
        hub.publish(chatId, { _tag: "Slot", entry })
        return entry
      }).pipe(Effect.uninterruptible, internal("SetThinkingHidden"))
  }
})
