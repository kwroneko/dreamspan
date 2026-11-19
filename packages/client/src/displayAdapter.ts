import { Schema } from "effect"
import { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import type { DisplayInput } from "./features/chat/displayPipeline.ts"
import type { DisplayListContext } from "./features/chat/displayScripts.ts"
import type { DisplayResultV1, TimelineRowV1 } from "../../plugin-api/src/display.ts"

/** The most text one answer may carry across the worker boundary, in characters. */
const DISPLAY_ANSWER_CHARS = 2_000_000

// Project before traversal: neither whole versions/settings nor unknown card fields
// (including their getters) belong in the supported display contract.
export const displayInput = (input: DisplayInput) => ({
  text: input.text,
  version: {
    macroMode: input.version.macroMode,
    writer: input.version.writer,
    frozenMacros: input.version.frozenMacros
  },
  names: { user: input.names.user, char: input.names.char },
  card: cardData(input.card),
  prefs: { outputMacros: input.prefs.outputMacros, displayRegex: input.prefs.displayRegex },
  scripts: input.scripts.map(scriptData),
  placement: input.placement,
  depth: input.depth,
  streaming: input.streaming ?? false
})
const cardData = (card: DisplayInput["card"]): DisplayInput["card"] => ({
  ...Object.fromEntries(
    [
      "description",
      "personality",
      "scenario",
      "persona",
      "mesExamples",
      "systemPrompt",
      "postHistoryInstructions",
      "depthPrompt",
      "creatorNotes",
      "version",
      "firstMessage"
    ]
      .filter((key) => Object.hasOwn(card, key))
      .map((key) => [key, card[key as keyof typeof card]])
  ),
  ...(card.alternateGreetings ? { alternateGreetings: [...card.alternateGreetings] } : {}),
  ...(card.joinedVolatile ? { joinedVolatile: [...card.joinedVolatile] } : {}),
  ...(card.joined
    ? {
        joined: {
          description: card.joined.description,
          personality: card.joined.personality,
          scenario: card.joined.scenario
        }
      }
    : {})
})
const scriptData = (s: RegexScript): RegexScript => ({
  id: s.id,
  name: s.name,
  find_regex: s.find_regex,
  replace_string: s.replace_string,
  trim_strings: [...s.trim_strings],
  placement: [...s.placement],
  disabled: s.disabled,
  markdown_only: s.markdown_only,
  prompt_only: s.prompt_only,
  run_on_edit: s.run_on_edit,
  substitute_regex: s.substitute_regex,
  min_depth: s.min_depth,
  max_depth: s.max_depth
})
export const displayListInput = (input: DisplayListContext) => ({
  global: input.global.map(scriptData),
  preset: input.preset.map(scriptData),
  character: input.character.map(scriptData),
  characterId: input.characterId,
  placement: input.placement
})
export const displayResult = (value: unknown): DisplayResultV1 => {
  const result = value as DisplayResultV1 | null
  if (
    !result ||
    typeof result.text !== "string" ||
    result.text.length > 1_000_000 ||
    !Array.isArray(result.issues) ||
    result.issues.length > 100 ||
    result.issues.some((issue: unknown) => typeof issue !== "string" || issue.length > 2000)
  )
    throw new Error("Invalid display output")
  return { text: result.text, issues: [...result.issues] }
}
const decodeScripts = Schema.decodeUnknownSync(Schema.Array(RegexScript))
export const displayListResult = (value: unknown): ReadonlyArray<RegexScript> => {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid script list")
  const scripts = decodeScripts(value).map(scriptData)
  let chars = 0
  for (const script of scripts) {
    if (script.trim_strings.length > 100 || script.placement.length > 100) throw new Error("Invalid script list")
    chars += script.id.length + script.name.length + script.find_regex.length + script.replace_string.length
    for (const trim of script.trim_strings) chars += trim.length
    if (chars > DISPLAY_ANSWER_CHARS) throw new Error("Script list is too large")
  }
  return scripts
}

const BODY_KINDS = ["merge", "history", "lcm-boundary", "lcm-tabs", "summary", "threads", "text"]
/** Validate data rows before any render closures are reattached, and rebuild each from the
 * contract's own fields: nothing else an answer carries (extra properties, a forged prototype
 * key) reaches the page's objects. Infinity is the existing empty-range sentinel; NaN,
 * duplicate keys, arbitrary bodies and more than DISPLAY_ANSWER_CHARS of text in all fail. */
export const timelineResult = (value: unknown): ReadonlyArray<TimelineRowV1> => {
  if (!Array.isArray(value) || value.length > 2000) throw new Error("Invalid timeline output")
  const keys = new Set<string>()
  let chars = 0
  return (value as ReadonlyArray<TimelineRowV1 | null>).map((row): TimelineRowV1 => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.key !== "string" ||
      row.key.length > 200 ||
      keys.has(row.key) ||
      typeof row.estimate !== "number" ||
      !Number.isFinite(row.estimate) ||
      row.estimate < 1 ||
      row.estimate > 100000 ||
      typeof row.from !== "number" ||
      typeof row.to !== "number" ||
      !(
        (row.from === Infinity || (Number.isSafeInteger(row.from) && row.from >= 0)) &&
        (row.to === -1 || (Number.isSafeInteger(row.to) && row.to >= row.from))
      ) ||
      (row.lastSlotId !== undefined && (typeof row.lastSlotId !== "string" || row.lastSlotId.length > 100)) ||
      (row.entry !== undefined &&
        (!row.entry ||
          typeof row.entry !== "object" ||
          typeof row.entry.slotId !== "string" ||
          row.entry.slotId.length > 100 ||
          !Number.isSafeInteger(row.entry.depth) ||
          row.entry.depth < 0 ||
          (row.entry.position !== undefined && (!Number.isSafeInteger(row.entry.position) || row.entry.position < 0)) ||
          (row.entry.version !== null &&
            (!row.entry.version ||
              typeof row.entry.version !== "object" ||
              typeof row.entry.version.origin !== "string" ||
              row.entry.version.origin.length > 100)))) ||
      (row.body !== undefined &&
        (!row.body ||
          typeof row.body !== "object" ||
          !BODY_KINDS.includes(row.body.kind) ||
          (row.body.ref !== undefined && (typeof row.body.ref !== "string" || row.body.ref.length > 200)) ||
          (row.body.text !== undefined && (typeof row.body.text !== "string" || row.body.text.length > 200000))))
    )
      throw new Error("Invalid timeline row")
    keys.add(row.key)
    chars += row.key.length + (row.body?.text?.length ?? 0)
    if (chars > DISPLAY_ANSWER_CHARS) throw new Error("Timeline output is too large")
    return {
      key: row.key,
      estimate: row.estimate,
      from: row.from,
      to: row.to,
      ...(row.lastSlotId === undefined ? {} : { lastSlotId: row.lastSlotId }),
      ...(row.entry === undefined
        ? {}
        : {
            entry: {
              slotId: row.entry.slotId,
              depth: row.entry.depth,
              ...(row.entry.position === undefined ? {} : { position: row.entry.position }),
              version: row.entry.version === null ? null : { origin: row.entry.version.origin }
            }
          }),
      ...(row.body === undefined
        ? {}
        : {
            body: {
              kind: row.body.kind,
              ...(row.body.ref === undefined ? {} : { ref: row.body.ref }),
              ...(row.body.text === undefined ? {} : { text: row.body.text })
            }
          })
    }
  })
}
