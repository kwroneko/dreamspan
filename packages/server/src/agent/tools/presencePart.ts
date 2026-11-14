// Scene-presence policy. Storage/ownership and causal reads stay in the host adapter.
import { Effect } from "effect"
import type { PresenceTool } from "../../../../plugin-api/src/server.ts"

export const presencePart: PresenceTool & { readonly source: string } = {
  source: import.meta.url,
  id: "set_presence",
  label: "Changed who's present",
  explanation: "Mark characters present or away",
  effect: "chat_state",
  description:
    "Marks a character as present in the scene or away from it, from the next message on. An away character isn't picked to reply until it's back. Use it when a character leaves or returns in the story.",
  parameters: {
    type: "object",
    required: ["character", "present"],
    properties: {
      character: { type: "string", description: "The character's name." },
      present: { type: "boolean", description: "True when the character is in the scene." }
    }
  },
  summarize: ({ character, present }) => `${character}: ${present ? "present" : "away"}`,
  execute: (context, { character, present }) =>
    Effect.gen(function* () {
      const cards = yield* context.cast
      const wanted = character.trim().toLowerCase()
      const card = cards.find((c) => [c.modelName, c.name].some((n) => n?.trim().toLowerCase() === wanted))
      if (!card)
        return {
          text: `No character called “${character}” is in the chat. In it: ${cards.map((c) => c.modelName ?? c.name).join(", ") || "nobody"}.`,
          isError: true
        }
      const name = card.modelName ?? card.name
      if (card.narrator) return { text: `${name} is the narrator, who is never in or out of the scene.`, isError: true }
      const result = yield* context.set(
        card.id,
        present,
        `${name} is ${present ? "present" : "away"} from the next message on.`
      )
      return { text: result }
    })
}
