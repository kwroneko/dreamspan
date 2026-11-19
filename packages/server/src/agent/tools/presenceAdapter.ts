import { savedToolResult } from "../toolData.ts"
// Credential-free adapter shared by the built-in and its editable replacements.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { PresenceContext } from "../../../../plugin-api/src/server.ts"
import type { ToolContext } from "../tools.ts"

export const presenceContext = (context: ToolContext, enabled: () => boolean = () => true): PresenceContext => {
  const live = Effect.sync(() => {
    if (!enabled()) throw new Error("Plugin is disabled")
  })
  const cast = Effect.gen(function* () {
    yield* live
    const { participants, roles } = foldState(
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
    yield* live
    return Object.freeze(
      cards.map((c) =>
        Object.freeze({
          id: c.entityId,
          name: c.name,
          modelName: c.modelName ?? null,
          narrator: roles[c.entityId] === "narrator"
        })
      )
    )
  })
  return Object.freeze({
    cast,
    set: (id: string, present: boolean, result: string) =>
      Effect.gen(function* () {
        yield* live
        const cards = yield* cast
        if (
          !cards.some((c) => c.id === id && !c.narrator) ||
          typeof present !== "boolean" ||
          typeof result !== "string" ||
          result.length > 15000
        )
          return yield* Effect.fail(new Error("Invalid presence change"))
        yield* live
        const saved = yield* context.writer.ApplyRolloutEffect({
          userId: context.userId,
          rolloutId: context.rolloutId,
          toolCallId: context.toolCallId,
          events: [{ key: "away.set", value: { entity: id as EntityId, away: !present } }],
          result: savedToolResult(context, result)
        })
        return saved.result
      })
  })
}
