// Carrying on an agent reply (spec/AGENTIC.md §4.2, §4.4, §5.2, §5.3), apart from React so it's
// tested on its own: when a reply offers Resume, and what a step's edit in the run inspector
// sends, with the arguments of a tool call checked against the tool's frozen schema first.
import type { StepEdit, TranscriptEntry, TurnPart } from "@rp/shared/agent.ts"
import type { Version } from "@rp/shared/chat.ts"

const RESUMABLE = new Set<Version["status"]>(["stopped", "failed", "interrupted"])

/**
 * Whether a version offers Resume: an agent reply that stopped, failed or was cut off by a
 * restart. One that stopped before writing anything (no step, no text, no thinking) offers it
 * disabled, with this reason.
 */
export const resumeOffer = (version: Version): { readonly disabled: string | null } | null => {
  if (version.agent !== true || version.writer !== "model" || !RESUMABLE.has(version.status)) return null
  const wrote = version.steps !== undefined || version.content.trim() !== "" || (version.reasoning ?? "").trim() !== ""
  return { disabled: wrote ? null : "This reply stopped before its first step." }
}

/** What a step of the inspector is: the part of the model's turn, or a tool's result. */
export type StepTarget =
  | { readonly kind: "part"; readonly part: TurnPart }
  | { readonly kind: "result"; readonly entry: Extract<TranscriptEntry, { role: "toolResult" }> }

/** The text the step's editor opens with: a call's arguments as JSON, else the text verbatim. */
export const editableText = (target: StepTarget) =>
  target.kind === "result"
    ? target.entry.text
    : target.part.type === "toolCall"
      ? JSON.stringify(target.part.args ?? {}, null, 2)
      : target.part.text

interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: ReadonlyArray<string>
  readonly enum?: ReadonlyArray<unknown>
  readonly const?: unknown
  readonly items?: JsonSchema
  readonly anyOf?: ReadonlyArray<JsonSchema>
}

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: "text in quotes",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  null: "null"
}

const fits = (value: unknown, type: string) => (type === "integer" ? Number.isInteger(value) : type === typeOf(value))

/**
 * Why `value` doesn't fit `schema`, at `path`; null when it does. The checks the tools' schemas
 * use (type, required, properties, enum, const, items, anyOf); the tool's own validation still
 * runs when the call does.
 */
export const schemaProblem = (value: unknown, schema: unknown, path = "The arguments"): string | null => {
  if (schema === null || typeof schema !== "object") return null
  const s = schema as JsonSchema
  if (s.anyOf)
    return s.anyOf.some((option) => schemaProblem(value, option, path) === null)
      ? null
      : `${path} ${path === "The arguments" ? "don't" : "doesn't"} fit any of its allowed forms.`
  const types = s.type === undefined ? [] : typeof s.type === "string" ? [s.type] : s.type
  if (types.length > 0 && !types.some((type) => fits(value, type)))
    return `${path} must be ${types.map((t) => TYPE_WORDS[t] ?? t).join(" or ")}.`
  if (s.const !== undefined && value !== s.const) return `${path} must be ${JSON.stringify(s.const)}.`
  if (s.enum && !s.enum.includes(value))
    return `${path} must be one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}.`
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>
    for (const key of s.required ?? []) if (!(key in object)) return `“${key}” is missing.`
    for (const [key, property] of Object.entries(s.properties ?? {}))
      if (key in object) {
        const problem = schemaProblem(object[key], property, `“${key}”`)
        if (problem !== null) return problem
      }
  }
  if (typeOf(value) === "array" && s.items)
    for (const [i, item] of (value as Array<unknown>).entries()) {
      const problem = schemaProblem(
        item,
        s.items,
        path === "The arguments" ? `Item ${i + 1}` : `Item ${i + 1} of ${path}`
      )
      if (problem !== null) return problem
    }
  return null
}

/**
 * The edit `text` makes to the step, or why it can't be sent. A call's arguments must be a JSON
 * object that fits the tool's frozen `parameters`. Unchanged text sends no edit: Resume from here.
 */
export const stepEdit = (
  target: StepTarget,
  text: string,
  parameters: unknown
): { readonly edit: StepEdit | undefined } | { readonly problem: string } => {
  if (text === editableText(target)) return { edit: undefined }
  if (target.kind === "result") return { edit: { kind: "result", text } }
  if (target.part.type !== "toolCall") return { edit: { kind: "text", text } }
  let args: unknown
  try {
    args = JSON.parse(text)
  } catch {
    return { problem: "The arguments aren't valid JSON." }
  }
  if (typeOf(args) !== "object") return { problem: "The arguments must be a JSON object, in braces." }
  const problem = schemaProblem(args, parameters)
  return problem === null
    ? { edit: { kind: "arguments", arguments: args as Record<string, unknown> } }
    : { problem: `${problem} Check them against the tool's parameters above.` }
}
