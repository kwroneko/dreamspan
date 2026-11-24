import { ORDER_UNIT } from "./changeReversal.ts"
// What a library document's text fields are, by kind: their places, labels and text, in the
// order the editors show them. The editors' Search and replace (client features/editor/fields.ts,
// which adds fields that features register) and Search and replace across the library
// (server db/libraryReplace.ts) both read them, so a field one finds the other finds too.
import type { LorebookDoc } from "./docs/lorebook.ts"
import { type FieldPath, getAt, validateDoc } from "./editing.ts"
import type { Doc, EntityKind } from "./library.ts"
import { makeRegistry } from "./registry.ts"

const CARD_LABELS: Record<string, string> = {
  name: "Display name",
  nickname: "In-chat nickname",
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
  regex: "Regex scripts",
  regex_approved: "Regex scripts allowed",
  html_scripts_approved: "Panel scripts allowed",
  html_network_approved: "Panels may use the internet",
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
  html_scripts_approved: "Panel scripts allowed",
  html_network_approved: "Panels may use the internet",
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
  if (second === ORDER_UNIT) return /order$/i.test(first) ? first : `${first} order`
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

/** A text the search looks through, and how to put a changed text back. */
export interface Searchable {
  readonly path: FieldPath
  readonly label: string
  readonly text: string
  /** Set when the text is an element of a list that's saved whole. */
  readonly inList?: { readonly path: FieldPath; readonly index: number }
}

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

/** A document's regex scripts' text fields (`regex`), for a section that shows them. */
export const regexScriptFields = (kind: EntityKind, doc: Doc): ReadonlyArray<Searchable> =>
  identified(doc, "regex", "id", ["name", "find_regex", "replace_string"]).map((entry) => ({
    ...entry,
    label: fieldLabel(kind, doc, entry.path)
  }))

/** Every text field of the document, in the order the editor shows them. */
export const builtinSearchable = (kind: EntityKind, doc: Doc): ReadonlyArray<Searchable> => {
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
      ...regexScriptFields(kind, doc)
    ]
  }
  return strings(doc, [["title"], ["content"]]).map(label)
}

/** A book's editable text at `root`, including entries whose forms aren't mounted. */
const bookFields = (book: LorebookDoc | undefined, root: FieldPath, bookLabel: string): ReadonlyArray<Searchable> => {
  if (!book) return []
  return [
    ...(["name", "description"] as const).map((key) => ({
      path: [...root, key],
      label: `${bookLabel}: ${key === "name" ? "Name" : "Description"}`,
      text: book[key]
    })),
    ...book.entries.flatMap((entry) => {
      const path = [...root, "entries", `uid=${entry.uid}`]
      const title = `Lorebook entry ${entry.comment ? `“${entry.comment}”` : entry.uid}`
      return [
        ...(["comment", "content", "outlet_name", "group"] as const).map((key) => ({
          path: [...path, key],
          label: `${title}: ${{ comment: "Title", content: "Content", outlet_name: "Outlet name", group: "Inclusion group" }[key]}`,
          text: entry[key]
        })),
        ...(["keys", "secondary_keys"] as const).flatMap((key) =>
          entry[key].map((text, index) => ({
            path: [...path, key, index],
            label: `${title}: ${key === "keys" ? "Primary" : "Secondary"} key ${index + 1}`,
            text,
            inList: { path: [...path, key], index }
          }))
        )
      ]
    })
  ]
}

/** The card's embedded section. */
export const lorebookFields = (doc: Doc): ReadonlyArray<Searchable> =>
  bookFields(doc.character_book as LorebookDoc | undefined, ["character_book"], "Embedded lorebook")

/** A standalone lorebook: the document is the book. */
export const standaloneLorebookFields = (doc: Doc): ReadonlyArray<Searchable> =>
  bookFields(doc as unknown as LorebookDoc, [], "Lorebook")

/**
 * Every text field of a document the library can search: the built-in fields with, for a
 * card, its regex scripts and embedded lorebook, and for a lorebook its entries, as the
 * editors register them (features/editor/index.tsx).
 */
const coreLibraryTextFields = (kind: EntityKind, doc: Doc): ReadonlyArray<Searchable> =>
  [
    ...builtinSearchable(kind, doc),
    ...(kind === "card" ? [...regexScriptFields("card", doc), ...lorebookFields(doc)] : []),
    ...(kind === "lorebook" ? standaloneLorebookFields(doc) : [])
  ].filter((field) => typeof field.text === "string")

/** A searchable library kind; shared plugin modules register it in the client and DB readers. */
export const libraryReplaceKinds = makeRegistry<{
  readonly id: EntityKind
  readonly one: string
  readonly many: string
  readonly fields: (doc: Doc) => ReadonlyArray<Searchable>
  readonly validate: (doc: unknown) => ReturnType<typeof validateDoc>
}>([
  ...(["card", "lorebook", "preset", "note"] as const).map((kind) => ({
    id: kind,
    one: kind,
    many: { card: "Cards", lorebook: "Lorebooks", preset: "Presets", note: "Notes" }[kind],
    fields: (doc: Doc) => coreLibraryTextFields(kind, doc),
    validate: (doc: unknown) => validateDoc(kind, doc)
  }))
])

export const libraryTextFields = (kind: EntityKind, doc: Doc): ReadonlyArray<Searchable> =>
  libraryReplaceKinds.get(kind)?.fields(doc) ?? []
