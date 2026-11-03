// ST's name, card-field and state macros (public/scripts/macros/definitions/env-macros.js
// and state-macros.js at 06bde939). Card fields are expanded on first use and then reused for
// the rest of the expansion, as ST's lazy card fields are.
import type { CardFields } from "../context.ts"
import type { MacroCall, MacroSpec } from "../registry.ts"

type TextField = Exclude<keyof CardFields, "alternateGreetings" | "version" | "joined">

/** ST's baseChatReplace: expand, optionally collapse newlines, then remove carriage returns. */
const expanded = (call: MacroCall, text: string | undefined, scope: string) => {
  const trimmed = text?.trim()
  if (!trimmed) return ""
  const value = call.expandTemplate(trimmed, scope)
  return (call.context.collapseNewlines ? value.replace(/\n+/g, "\n") : value).replace(/\r/g, "")
}

export const cardField = (call: MacroCall, key: TextField) => expanded(call, call.context.card?.[key], `card.${key}`)

const fieldMacro = (name: string, key: TextField, aliases?: ReadonlyArray<string>): MacroSpec => ({
  kind: "value",
  name,
  ...(aliases ? { aliases } : {}),
  handler: (call) => {
    const joined = call.context.card?.joined
    // The characters' joined fields are expanded already: their macros never expand again.
    return joined && (key === "description" || key === "personality" || key === "scenario")
      ? joined[key]
      : cardField(call, key)
  }
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
  if (index === 0) return cardField(call, "firstMessage")
  // ST expands every alternate greeting on first use of any of them.
  const all = (call.context.card?.alternateGreetings ?? []).map((text, i) =>
    expanded(call, text, `card.alternateGreetings.${i}`)
  )
  return all[index - 1] ?? ""
}

export const characterMacros: ReadonlyArray<MacroSpec> = [
  { kind: "value", name: "user", handler: (call) => call.context.names.user },
  { kind: "value", name: "char", handler: (call) => call.context.names.char },
  {
    kind: "value",
    name: "group",
    aliases: ["charIfNotGroup"],
    handler: ({ context: { names } }) => names.group ?? names.char
  },
  { kind: "value", name: "groupNotMuted", handler: ({ context: { names } }) => names.groupNotMuted ?? names.char },
  { kind: "value", name: "notChar", handler: ({ context: { names } }) => names.notChar ?? names.user },
  fieldMacro("charPrompt", "systemPrompt"),
  fieldMacro("charInstruction", "postHistoryInstructions"),
  fieldMacro("charDescription", "description", ["description"]),
  fieldMacro("charPersonality", "personality", ["personality"]),
  fieldMacro("charScenario", "scenario", ["scenario"]),
  fieldMacro("persona", "persona"),
  fieldMacro("mesExamplesRaw", "mesExamples"),
  { kind: "value", name: "mesExamples", handler: (call) => formatExamples(cardField(call, "mesExamples")) },
  fieldMacro("charDepthPrompt", "depthPrompt"),
  fieldMacro("charCreatorNotes", "creatorNotes", ["creatorNotes"]),
  {
    kind: "value",
    name: "charFirstMessage",
    aliases: ["greeting"],
    args: [{ name: "index", optional: true, integer: true }],
    handler: greeting
  },
  {
    kind: "value",
    name: "charVersion",
    aliases: ["version", "char_version"],
    handler: (call) => call.context.card?.version ?? ""
  },
  { kind: "value", name: "model", handler: (call) => call.context.model ?? "" },
  {
    // Once per expansion. Without an original it stays as written, as ST's does.
    kind: "value",
    name: "original",
    handler: (call) => {
      const { original } = call.context
      if (original === undefined) throw new Error("No original text")
      return call.once("original") ? original : ""
    }
  },
  {
    // Registered by ST's Summarize extension; without a summary to read it stays as written.
    kind: "value",
    name: "summary",
    handler: (call) => {
      const { summary } = call.context
      if (summary === undefined) throw new Error("No summary")
      return summary
    }
  },
  {
    // Who the model writes as, and the direction it was given (DESIGN §2.2). Outside a
    // generation there's neither, and they stay as written. A macro's output is never expanded
    // again, so the direction is sent exactly as typed.
    kind: "value",
    name: "speaker",
    handler: (call) => {
      const { speaker } = call.context
      if (speaker === undefined) throw new Error("No speaker")
      return speaker
    }
  },
  {
    kind: "value",
    name: "direction",
    handler: (call) => {
      const { direction } = call.context
      if (direction === undefined) throw new Error("No direction")
      return direction
    }
  },
  { kind: "value", name: "isMobile", handler: (call) => String(call.context.isMobile ?? false) },
  { kind: "value", name: "lastGenerationType", handler: (call) => call.context.lastGenerationType ?? "" },
  // ST extensions don't exist here (DESIGN §1.5).
  { kind: "value", name: "hasExtension", args: [{ name: "extensionName" }], handler: () => "false" }
]
