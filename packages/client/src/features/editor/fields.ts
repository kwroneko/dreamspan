// What the editors call a document's fields: their labels, which hold text to search, and
// which differ between two versions of a document.
import { canonicalJson, type FieldPath, getAt, parseField } from "@rp/shared/editing.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import { makeRegistry } from "../../registry.ts"

const CARD_LABELS: Record<string, string> = {
  name: "Display name",
  nickname: "Name the model sees",
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  first_mes: "First message",
  mes_example: "Example messages",
  alternate_greetings: "Alternate greetings",
  group_only_greetings: "Group-only greetings",
  system_prompt: "System prompt",
  post_history_instructions: "Post-history instructions",
  creator_notes: "Creator's notes",
  tags: "Tags",
  creator: "Creator",
  character_version: "Version (shown as subtitle)",
  modules: "Modules",
  avatar_media_id: "Avatar",
  character_book: "Lorebook",
  extensions: "Extensions"
}

const PRESET_LABELS: Record<string, string> = {
  prompts: "Prompts",
  order: "Prompt order",
  samplers: "Samplers",
  utility_prompts: "Utility prompts",
  names_behavior: "Names",
  squash: "Squash system messages",
  postprocess: "Post-processing",
  use_sysprompt: "System prompt as a parameter",
  prefill: "Prefill",
  regex: "Regex scripts",
  regex_approved: "Regex scripts allowed",
  extensions: "Extensions",
  unsupported: "Fields kept for export"
}

const NOTE_LABELS: Record<string, string> = {
  title: "Title",
  content: "Content",
  placement: "Placement",
  exportable: "Exportable",
  agent_editable: "The agent may edit it"
}

/** A lorebook entry's fields as the entry table names them, after ST. */
const ENTRY_LABELS: Record<string, string> = {
  comment: "Title",
  keys: "Primary keys",
  secondary_keys: "Secondary keys",
  selective: "Use secondary keys",
  selective_logic: "Secondary keys logic",
  constant: "Strategy (constant)",
  vectorized: "Strategy (vectorized)",
  role: "Position (role)",
  probability: "Trigger %",
  use_probability: "Use the trigger %"
}

const LABELS: Partial<Record<EntityKind, Record<string, string>>> = {
  card: CARD_LABELS,
  preset: PRESET_LABELS,
  note: NOTE_LABELS
}

const words = (key: string) => {
  const text = key.replaceAll("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What an element of a list is called: its name or title, else its id. */
const elementName = (doc: Doc, path: FieldPath, removedFrom?: Doc) => {
  const element = (getAt(doc, path) ?? (removedFrom && getAt(removedFrom, path))) as
    { name?: unknown; title?: unknown; comment?: unknown } | undefined
  // A lorebook entry's title is its `comment`, as in ST.
  const name = element?.name || element?.title || element?.comment
  const segment = String(path.at(-1))
  return typeof name === "string" && name !== "" ? `“${name}”` : segment.slice(segment.indexOf("=") + 1)
}

/**
 * A field's label for the diff and the search, e.g. `Prompt “Main Prompt”: content`. An element
 * no longer in `doc` (a removed entry, say) is named from `removedFrom`, the saved document.
 */
export const fieldLabel = (kind: EntityKind, doc: Doc, path: FieldPath, removedFrom?: Doc): string => {
  const [top, second, ...rest] = path
  const first = LABELS[kind]?.[String(top)] ?? words(String(top))
  if (second === undefined) return first
  // A card's embedded book is labelled as a lorebook is: "Lorebook: Entry “Harbour”: Order".
  if (kind === "card" && top === "character_book") {
    const book = (at: Doc | undefined) => (at && (getAt(at, ["character_book"]) as Doc | undefined)) ?? undefined
    return `${first}: ${fieldLabel("lorebook", book(doc) ?? {}, [second, ...rest], book(removedFrom))}`
  }
  const part = (key: unknown) =>
    (kind === "lorebook" && top === "entries" && ENTRY_LABELS[String(key)]) || words(String(key))
  const singular =
    { prompts: "Prompt", modules: "Module", regex: "Regex script", entries: "Entry" }[String(top)] ?? first
  if (typeof second === "number") {
    const named = elementName(doc, [top!, second], removedFrom)
    const head = named.startsWith("“") ? `${singular} ${named}` : `${first} ${second + 1}`
    return `${head}${rest.length > 0 ? `: ${rest.map(part).join(" ")}` : ""}`
  }
  const element = /^(id|identifier|uid)=/.test(second)
  const head = element ? `${singular} ${elementName(doc, [top!, second], removedFrom)}` : `${first}: ${words(second)}`
  return rest.length > 0 ? `${head}: ${rest.map(part).join(" ")}` : head
}

/** A draft field's label. */
export const draftLabel = (kind: EntityKind, doc: Doc, field: string) => {
  const parsed = parseField(field)
  return parsed ? fieldLabel(kind, doc, parsed.path) : field
}

/** A text the search looks through, and how to put a changed text back. */
export interface Searchable {
  readonly path: FieldPath
  readonly label: string
  readonly text: string
  /** Set when the text is an element of a list that's saved whole. */
  readonly inList?: { readonly path: FieldPath; readonly index: number }
}

interface TextFieldContribution {
  readonly id: string
  readonly kind: EntityKind
  readonly fields: (doc: Doc) => ReadonlyArray<Searchable>
}

/** Feature-owned document sections contribute their text without coupling the search UI to them. */
export const editorTextFields = makeRegistry<TextFieldContribution>()

const strings = (doc: Doc, paths: ReadonlyArray<FieldPath>) =>
  paths.flatMap((path) => {
    const text = getAt(doc, path)
    return typeof text === "string" ? [{ path, text }] : []
  })

const identified = (doc: Doc, list: string, key: string, fields: ReadonlyArray<string>) => {
  const elements = getAt(doc, [list])
  if (!Array.isArray(elements)) return []
  return elements.flatMap((element: Record<string, unknown>) =>
    strings(
      doc,
      fields.map((field) => [list, `${key}=${String(element[key])}`, field])
    )
  )
}

/** Every text field of the document, in the order the editor shows them. */
const builtinSearchable = (kind: EntityKind, doc: Doc): ReadonlyArray<Searchable> => {
  const label = (entry: { path: FieldPath; text: string }) => ({ ...entry, label: fieldLabel(kind, doc, entry.path) })
  if (kind === "card") {
    const top = ["name", "nickname", "description", "personality", "scenario", "first_mes"].map((key) => [key])
    const greetings = getAt(doc, ["alternate_greetings"])
    const rest = [
      "mes_example",
      "system_prompt",
      "post_history_instructions",
      "creator_notes",
      "creator",
      "character_version"
    ]
    return [
      ...strings(doc, top).map(label),
      ...(Array.isArray(greetings) ? greetings : []).flatMap((text: unknown, index) =>
        typeof text === "string"
          ? [
              {
                ...label({ path: ["alternate_greetings", index], text }),
                inList: { path: ["alternate_greetings"], index }
              }
            ]
          : []
      ),
      ...identified(doc, "modules", "id", ["title", "content"]).map(label),
      ...strings(
        doc,
        rest.map((key) => [key])
      ).map(label)
    ]
  }
  if (kind === "preset") {
    const utility = getAt(doc, ["utility_prompts"])
    return [
      ...identified(doc, "prompts", "identifier", ["name", "content"]).map(label),
      ...strings(doc, [
        ["prefill", "assistant"],
        ["prefill", "impersonation"]
      ]).map(label),
      ...strings(
        doc,
        Object.keys(typeof utility === "object" && utility !== null ? utility : {}).map((key) => [
          "utility_prompts",
          key
        ])
      ).map(label),
      ...identified(doc, "regex", "id", ["name", "find_regex", "replace_string"]).map(label)
    ]
  }
  return strings(doc, [["title"], ["content"]]).map(label)
}

export const searchable = (
  kind: EntityKind,
  doc: Doc,
  contributions: ReadonlyArray<TextFieldContribution> = editorTextFields.list()
): ReadonlyArray<Searchable> => [
  ...builtinSearchable(kind, doc),
  ...contributions.flatMap((entry) => (entry.kind === kind ? entry.fields(doc) : []))
]

/** A field that differs between two versions of a document. */
export interface FieldChange {
  readonly path: FieldPath
  readonly before: unknown
  readonly after: unknown
}

const IDENTITIES = ["id", "identifier", "uid"] as const

const identityOf = (list: ReadonlyArray<unknown>) =>
  IDENTITIES.find((key) => list.every((element) => typeof element === "object" && element !== null && key in element))

/**
 * The fields that differ, per field: objects key by key, lists with identities element by
 * element, two levels down, and anything else whole.
 */
export const changedFields = (before: unknown, after: unknown, path: FieldPath = []): ReadonlyArray<FieldChange> => {
  if (canonicalJson(before) === canonicalJson(after)) return []
  const isRecord = (u: unknown): u is Record<string, unknown> =>
    typeof u === "object" && u !== null && !Array.isArray(u)
  if (path.length < 3 && isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    return keys.flatMap((key) => changedFields(before[key], after[key], [...path, key]))
  }
  if (path.length < 2 && Array.isArray(before) && Array.isArray(after)) {
    const key = identityOf([...before, ...after])
    if (key !== undefined) {
      const named = (list: ReadonlyArray<Record<string, unknown>>) =>
        new Map(list.map((element) => [`${key}=${String(element[key])}`, element]))
      const a = named(before as Array<Record<string, unknown>>)
      const b = named(after as Array<Record<string, unknown>>)
      const ids = [...new Set([...a.keys(), ...b.keys()])]
      const changes = ids.flatMap((id) => changedFields(a.get(id), b.get(id), [...path, id]))
      // Reordered with nothing else changed: the list's order is the change.
      return changes.length > 0 ? changes : [{ path, before, after }]
    }
  }
  return [{ path, before, after }]
}
