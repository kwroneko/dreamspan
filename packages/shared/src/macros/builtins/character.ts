// ST's name, card-field and state macros (public/scripts/macros/definitions/env-macros.js
// and state-macros.js at 06bde939). Card fields are expanded on first use and then reused for
// the rest of the expansion, as ST's lazy card fields are.
import type { CardFields } from "../context.ts"
import type { MacroCall, MacroSpec } from "../registry.ts"

type TextField = Exclude<keyof CardFields, "alternateGreetings" | "version">

/** ST's baseChatReplace: trimmed, expanded without card fields, carriage returns removed. */
const expanded = (call: MacroCall, text: string | undefined, scope: string) => {
  const trimmed = text?.trim()
  return trimmed ? call.expandTemplate(trimmed, scope).replace(/\r/g, "") : ""
}

const field = (call: MacroCall, key: TextField) => expanded(call, call.context.card?.[key], `card.${key}`)

const fieldMacro = (name: string, key: TextField, aliases?: ReadonlyArray<string>): MacroSpec => ({
  name,
  ...(aliases ? { aliases } : {}),
  handler: (call) => field(call, key)
})

/** ST's parseMesExamples for chat completion: each example block headed by `<START>`. */
const formatExamples = (raw: string) => {
  if (!raw || raw === "<START>") return ""
  const text = raw.startsWith("<START>") ? raw : `<START>\n${raw.trim()}`
  return text
    .split(/<START>/i)
    .slice(1)
    .map((block) => `<START>\n${block.trim()}\n`)
    .join("")
}

const greeting = (call: MacroCall) => {
  const index = Number(call.args[0] ?? 0)
  if (index === 0) return field(call, "firstMessage")
  // ST expands every alternate greeting on first use of any of them.
  const all = (call.context.card?.alternateGreetings ?? []).map((text, i) =>
    expanded(call, text, `card.alternateGreetings.${i}`)
  )
  return all[index - 1] ?? ""
}

export const characterMacros: ReadonlyArray<MacroSpec> = [
  { name: "user", handler: (call) => call.context.names.user },
  { name: "char", handler: (call) => call.context.names.char },
  {
    name: "group",
    aliases: ["charIfNotGroup"],
    handler: ({ context: { names } }) => names.group ?? names.char
  },
  { name: "groupNotMuted", handler: ({ context: { names } }) => names.groupNotMuted ?? names.char },
  { name: "notChar", handler: ({ context: { names } }) => names.notChar ?? names.user },
  fieldMacro("charPrompt", "systemPrompt"),
  fieldMacro("charInstruction", "postHistoryInstructions"),
  fieldMacro("charDescription", "description", ["description"]),
  fieldMacro("charPersonality", "personality", ["personality"]),
  fieldMacro("charScenario", "scenario", ["scenario"]),
  fieldMacro("persona", "persona"),
  fieldMacro("mesExamplesRaw", "mesExamples"),
  { name: "mesExamples", handler: (call) => formatExamples(field(call, "mesExamples")) },
  fieldMacro("charDepthPrompt", "depthPrompt"),
  fieldMacro("charCreatorNotes", "creatorNotes", ["creatorNotes"]),
  {
    name: "charFirstMessage",
    aliases: ["greeting"],
    args: [{ name: "index", optional: true, integer: true }],
    handler: greeting
  },
  {
    name: "charVersion",
    aliases: ["version", "char_version"],
    handler: (call) => call.context.card?.version ?? ""
  },
  { name: "model", handler: (call) => call.context.model ?? "" },
  {
    // Once per expansion. Without an original it stays as written, as ST's does.
    name: "original",
    handler: (call) => {
      const { original } = call.context
      if (original === undefined) throw new Error("No original text")
      return call.once("original") ? original : ""
    }
  },
  { name: "isMobile", handler: (call) => String(call.context.isMobile ?? false) },
  { name: "lastGenerationType", handler: (call) => call.context.lastGenerationType ?? "" },
  // ST extensions don't exist here (DESIGN §1.5).
  { name: "hasExtension", args: [{ name: "extensionName" }], handler: () => "false" }
]
