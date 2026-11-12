// set_presence (spec/AGENTIC.md §4.5; spec/CHARACTER-CONTEXT.md §5): a character away from the
// scene or back, from the next message on, as the user's away mark writes it (`away.set`, apart
// from Mute), attached to the reply being written, so a swipe takes it back. A narrator is never
// in or out of the scene (§6), so it's refused.
import { Type } from "@earendil-works/pi-ai"
import type { EntityId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { RolloutTool } from "../tools.ts"
import { safely } from "./history.ts"

export const setPresence: RolloutTool<{ readonly character: string; readonly present: boolean }> = {
  id: "set_presence",
  label: "Changed who's present",
  explanation: "Mark characters present or away",
  effect: "chat_state",
  description:
    "Marks a character as present in the scene or away from it, from the next message on. An away character isn't picked to reply until it's back. Use it when a character leaves or returns in the story.",
  parameters: Type.Object({
    character: Type.String({ description: "The character's name." }),
    present: Type.Boolean({ description: "True when the character is in the scene." })
  }),
  summarize: ({ character, present }) => `${character}: ${present ? "present" : "away"}`,
  execute: (context, { character, present }) =>
    safely(
      "set_presence",
      Effect.gen(function* () {
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
        const wanted = character.trim().toLowerCase()
        const card = cards.find((c) => [c.modelName, c.name].some((n) => n?.trim().toLowerCase() === wanted))
        if (!card)
          return {
            text: `No character called “${character}” is in the chat. In it: ${cards.map((c) => c.modelName ?? c.name).join(", ") || "nobody"}.`,
            isError: true
          }
        const name = card.modelName ?? card.name
        if (roles[card.entityId] === "narrator")
          return { text: `${name} is the narrator, who is never in or out of the scene.`, isError: true }
        const { result } = yield* context.writer.ApplyRolloutEffect({
          userId: context.userId,
          rolloutId: context.rolloutId,
          toolCallId: context.toolCallId,
          events: [{ key: "away.set", value: { entity: card.entityId, away: !present } }],
          result: `${name} is ${present ? "present" : "away"} from the next message on.`
        })
        return { text: result }
      })
    )
}
