// The agent's lorebook lookup (spec/AGENTIC.md §4.5): the entries of the lorebooks this reply's
// context was assembled with, by title or by words. It only reads: which entries the context
// admits, and when, stays the assembler's (lore_activations).
import { Type } from "@earendil-works/pi-ai"
import { Effect } from "effect"
import type { RolloutTool } from "../tools.ts"
import { safely } from "./history.ts"

export const lookupLore: RolloutTool<{ readonly query?: string; readonly entry?: string; readonly limit?: number }> = {
  source: import.meta.url,
  id: "lookup_lore",
  label: "Looked up the lore",
  explanation: "Look up lorebook entries",
  effect: "read",
  description:
    "Looks up the story's lorebook entries: by words in their keys, titles or text, or one entry by its title. Use it for a detail of the world, a place, a faction or a character that isn't in front of you. Entries already in the context don't need looking up.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Words that must all appear, case aside." })),
    entry: Type.Optional(Type.String({ description: "An entry's title, to read that entry." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Most entries (5)." }))
  }),
  summarize: ({ query, entry }) => entry ?? query ?? "",
  execute: (context, { query, entry, limit = 5 }) =>
    safely(
      "lookup_lore",
      Effect.gen(function* () {
        if (!query?.trim() && !entry?.trim())
          return { text: "Give words to look for, or an entry's title.", isError: true }
        const { books, entries } = yield* context.reader.LookupLore({
          userId: context.userId,
          rolloutId: context.rolloutId,
          query: query?.trim() || null,
          entry: entry?.trim() || null,
          limit: Math.min(limit, 10)
        })
        if (books === 0) return { text: "This story has no lorebooks." }
        if (entries.length === 0) return { text: `No lorebook entry matches “${entry ?? query}”.` }
        return {
          text: entries
            .map(
              (e) =>
                `“${e.title || `Entry ${e.uid}`}” (${e.book || "Lorebook"}${e.keys.length ? `; keys: ${e.keys.join(", ")}` : ""}):\n${e.content}`
            )
            .join("\n\n")
        }
      })
    )
}
