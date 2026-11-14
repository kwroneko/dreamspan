// ST's instruct, system-prompt and context-template macros
// (public/scripts/macros/definitions/instruct-macros.js at 06bde939). Text completion is out of
// scope (DESIGN §1.2), so they resolve as in ST with instruct mode off, rather than reaching
// the model as literal text:
// - The instruct sequences are empty.
// - `{{systemPrompt}}` is the card's own system prompt, as ST prefers it by default; ST would
//   fall back to its text-completion system prompt, which doesn't exist here, so it's empty.
//   `{{defaultSystemPrompt}}` is that missing prompt, so it's always empty.
// - `{{chatStart}}` and `{{exampleSeparator}}` are ST's default context template's "***".
import type { MacroSpec } from "../registry.ts"
import { cardField } from "./character.ts"

const empty = (name: string, ...aliases: ReadonlyArray<string>): MacroSpec => ({
  source: import.meta.url,
  kind: "value",
  name,
  ...(aliases.length > 0 ? { aliases } : {}),
  handler: () => ""
})

export const promptMacros: ReadonlyArray<MacroSpec> = [
  empty("instructStoryStringPrefix"),
  empty("instructStoryStringSuffix"),
  empty("instructUserPrefix", "instructInput"),
  empty("instructUserSuffix"),
  empty("instructAssistantPrefix", "instructOutput"),
  empty("instructAssistantSuffix", "instructSeparator"),
  empty("instructSystemPrefix"),
  empty("instructSystemSuffix"),
  empty("instructFirstAssistantPrefix", "instructFirstOutputPrefix"),
  empty("instructLastAssistantPrefix", "instructLastOutputPrefix"),
  empty("instructStop"),
  empty("instructUserFiller"),
  empty("instructSystemInstructionPrefix"),
  empty("instructFirstUserPrefix", "instructFirstInput"),
  empty("instructLastUserPrefix", "instructLastInput"),
  empty("defaultSystemPrompt", "instructSystem", "instructSystemPrompt"),
  {
    source: import.meta.url,
    kind: "value",
    name: "systemPrompt",
    handler: (call) => cardField(call, "systemPrompt")
  },
  {
    source: import.meta.url,
    kind: "value",
    name: "exampleSeparator",
    aliases: ["chatSeparator"],
    handler: () => "***"
  },
  {
    source: import.meta.url,
    kind: "value",
    name: "chatStart",
    handler: () => "***"
  }
]
