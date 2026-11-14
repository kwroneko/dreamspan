// Who is in the scene for the message `send_message` sends (`present`; DESIGN §3.5, §7.2):
// the names resolved against the cast the message was written for, then recorded with the
// message in one write keyed by the tool call (`DeclareRolloutPresence`).
import type { EntityId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ToolContext } from "../tools.ts"

/**
 * Records `names` as the characters present for the message being sent. Null when recorded; a
 * refusal for the model when a name is nobody in the chat, so it can send again. A narrator
 * and the user's own character may be named or left out: neither changes.
 */
export const declarePresence = (context: ToolContext, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { participants } = foldState(
      yield* context.reader.StateEventsAt({
        userId: context.userId,
        chatId: context.chatId,
        slotId: context.leafSlotId,
        forkId: context.forkId
      })
    )
    const cards = participants.length
      ? yield* context.reader.CastCards({ userId: context.userId, entityIds: participants as Array<EntityId> })
      : []
    const called = (name: string) => {
      const wanted = name.trim().toLowerCase()
      return cards.find((c) => [c.modelName, c.name].some((n) => n?.trim().toLowerCase() === wanted))
    }
    const unknown = names.filter((name) => !called(name))
    if (unknown.length)
      return `No character called ${unknown.map((name) => `“${name}”`).join(", ")} is in the chat. In it: ${
        cards.map((c) => c.modelName ?? c.name).join(", ") || "nobody"
      }. Send the message again with \`present\` naming only them.`
    const present = [...new Set(names.map((name) => called(name)!.entityId))]
    yield* context.writer.DeclareRolloutPresence({
      userId: context.userId,
      rolloutId: context.rolloutId,
      toolCallId: context.toolCallId,
      present
    })
    return null
  })
