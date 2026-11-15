// RPC handlers for separate contexts in the app (@rp/shared/contextsApi.ts; spec/CHARACTER-CONTEXT.md
// §9.2 unit CU3): the timeline's away rows and Undo of a scene check's mark (writer
// `CorrectPresence`, unit C9). Every handler acts as the authenticated user; storage enforces
// ownership, so another user's ids are NotFound.
import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeChatContextsHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    GetStateMarks: (payload: { chatId: ChatId; forkId: ForkId; slotId: SlotId | null; keys: ReadonlyArray<string> }) =>
      Effect.flatMap(userId, (id) => reader.StateMarks({ userId: id, ...payload })).pipe(internal("GetStateMarks")),
    GetAwayMarks: (payload: { chatId: ChatId; forkId: ForkId; slotId: SlotId | null }) =>
      Effect.flatMap(userId, (id) => reader.AwayMarks({ userId: id, ...payload })).pipe(internal("GetAwayMarks")),
    UndoAwayMark: (payload: { chatId: ChatId; forkId: ForkId; eventId: string }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Another user's chat is NotFound, as everywhere, not just "nothing to undo".
        yield* reader.GetChat({ userId: id, chatId: payload.chatId })
        const corrected = yield* writer.CorrectPresence({ userId: id, ...payload })
        if (corrected === null) return false
        // The cast and the rows read again; what's generated next reads the correction.
        hub.publish(payload.chatId, { _tag: "State", forkId: payload.forkId })
        return true
      }).pipe(internal("UndoAwayMark"))
  }
})
