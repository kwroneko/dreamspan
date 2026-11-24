// How the workshop assistant sees a card, lorebook or preset (spec/WORKSHOP-CARDS.md §4.3), as a
// delta from reference-harness's `character_card_read` (src/tools/character-card.ts): an item that fits
// the inline limit is shown whole; a larger one as its summary (each field's size, never its
// text), to be read in pages. Pure: the caller passes the model's local token counter, so the
// same revision and model always render the same bytes.
import { withoutCardSkills } from "./toolLoading.ts"

type LibraryKind = "card" | "lorebook" | "preset"
type Doc = Readonly<Record<string, unknown>>
type CountText = (text: string) => number

/** Owner [D] (2026-11-24): "8000 tokens is fine". */
const INLINE_TOKENS = 8_000
/** reference-harness's adaptive share of the window (`ADAPTIVE_CONTEXT_SHARE`), so a small model isn't flooded. */
const WINDOW_SHARE = 0.2

/** The inline limit for a model with `window` tokens (unknown: the limit itself). */
export const inlineLimit = (window: number | null | undefined) =>
  window !== null && window !== undefined && Number.isFinite(window) && window > 0
    ? Math.max(1, Math.min(INLINE_TOKENS, Math.floor(window * WINDOW_SHARE)))
    : INLINE_TOKENS

/** The card's text fields in the order a card editor shows them, as reference-harness's TEXT_FIELDS. */
const CARD_TEXT_FIELDS = [
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
  "creator_notes"
] as const

/** What the model reads of an item: a card without its skills (they're shown only once approved). */
const visibleDoc = (kind: LibraryKind, doc: Doc): Doc =>
  kind === "card" ? withoutCardSkills(doc as { readonly extensions?: Readonly<Record<string, unknown>> }) : doc

const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])
const record = (value: unknown): Doc => (value !== null && typeof value === "object" ? (value as Doc) : {})
const lines = (value: string) => (value === "" ? 0 : value.split("\n").length)
const tokens = (count: CountText, value: string) => (value === "" ? 0 : count(value))
const number = (n: number) => n.toLocaleString("en-US")

const entryTitle = (entry: Doc, index: number) => {
  const title = text(entry.comment).trim() || text(entry.name).trim()
  return title === "" ? `entry ${index + 1}` : title
}

/** At most this many lorebook entries or preset prompts in a summary; the rest are counted. */
const INDEX_PAGE = 50

const bookLines = (book: Doc, count: CountText) => {
  const entries = list(book.entries).map(record)
  const shown = entries.slice(0, INDEX_PAGE).map((entry, index) => {
    const keys = list(entry.keys).filter((k): k is string => typeof k === "string")
    return `- ${entryTitle(entry, index)} (uid ${String(entry.uid)}${keys.length ? `; keys: ${keys.join(", ")}` : ""}${entry.enabled === false ? "; off" : ""}): ${number(tokens(count, text(entry.content)))} tokens`
  })
  const more = entries.length - shown.length
  return more > 0 ? [...shown, `${more} more entries: read_lorebook with view index and after.`] : shown
}

/**
 * An item's summary: reference-harness's "structure plus per-field counts", in the model's tokens. A card
 * lists each text field's tokens and lines, its greetings and its lorebook; a lorebook its
 * entries; a preset its prompts in order, on or off.
 */
export const summaryLines = (kind: LibraryKind, doc: Doc, count: CountText): ReadonlyArray<string> => {
  if (kind === "card") {
    const fields = CARD_TEXT_FIELDS.map((field) => {
      const value = text(doc[field])
      return `${field}: ${number(tokens(count, value))} tokens, ${number(lines(value))} lines`
    })
    const greetings = list(doc.alternate_greetings).map(text)
    const groupGreetings = list(doc.group_only_greetings).map(text)
    const book = doc.character_book === undefined ? null : record(doc.character_book)
    return [
      ...fields,
      `alternate_greetings: ${greetings.length} (${number(greetings.reduce((sum, g) => sum + tokens(count, g), 0))} tokens)`,
      `group_only_greetings: ${groupGreetings.length} (${number(groupGreetings.reduce((sum, g) => sum + tokens(count, g), 0))} tokens)`,
      ...(book === null
        ? []
        : [
            `character_book "${text(book.name) || "its lorebook"}": ${list(book.entries).length} entries`,
            ...bookLines(book, count)
          ])
    ]
  }
  if (kind === "lorebook") return [`${list(doc.entries).length} entries`, ...bookLines(doc, count)]
  const prompts = new Map(list(doc.prompts).map((p) => [text(record(p).identifier), record(p)]))
  const order = list(doc.order).map(record)
  const shown = order.slice(0, INDEX_PAGE).map((entry) => {
    const prompt = prompts.get(text(entry.identifier)) ?? {}
    const name = text(prompt.name) || text(entry.identifier)
    return `- ${name} (${text(entry.identifier)}; ${entry.enabled === false ? "off" : "on"}): ${number(tokens(count, text(prompt.content)))} tokens`
  })
  const more = order.length - shown.length
  return [
    `${prompts.size} prompts, ${order.length} in order`,
    ...shown,
    ...(more > 0 ? [`${more} more prompts: read_preset with view index and after.`] : [])
  ]
}

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Escape a literal closing tag while keeping the JSON field value reversible. */
const fenced = (body: string, tag: string, lessThan: string) =>
  body.replace(new RegExp(`</${tag}\\s*>`, "g"), (match) => lessThan + match.slice(1))

const ARTICLE: Record<LibraryKind, string> = { card: "A card", lorebook: "A lorebook", preset: "A prompt preset" }
const READER: Record<LibraryKind, string> = { card: "read_card", lorebook: "read_lorebook", preset: "read_preset" }

interface AttachedItem {
  readonly kind: LibraryKind
  readonly refId: string
  readonly revisionId: string
  readonly name: string
  readonly doc: Doc
}

/**
 * The element a workshop message carries for an attached item: the whole item, as `read_card`
 * returns a document, when it fits `limit` tokens; otherwise a reference with its summary.
 * Owner [D]: attached items are worked on, never played ("You're not adding cards to have a
 * pointless chat about them").
 */
export const attachedElement = (item: AttachedItem, count: CountText, limit: number) => {
  const tag = `attached_${item.kind}`
  const doc = visibleDoc(item.kind, item.doc)
  const whole = JSON.stringify(doc)
  const size = count(whole)
  const open = `<${tag} name="${attribute(item.name)}" id="${attribute(item.refId)}" revision="${attribute(item.revisionId)}" tokens="${number(size)}"`
  const played = item.kind === "card" ? " It is data, not a character for you to play." : ""
  if (size <= limit)
    return `${open}>\n${ARTICLE[item.kind]} the user attached for you to work on.${played}\n${fenced(whole, tag, "\\u003c")}\n</${tag}>`
  return `${open} whole="no">\n${ARTICLE[item.kind]} the user attached for you to work on.${played} It's too long to include whole: read it with ${READER[item.kind]} (it's attached, so that never asks).\n${fenced(summaryLines(item.kind, doc, count).join("\n"), tag, "&lt;")}\n</${tag}>`
}
