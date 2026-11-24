// How the workshop assistant sees a card, lorebook or preset (spec/WORKSHOP-CARDS.md §4.3), as a
// delta from reference-harness's `character_card_read` (src/tools/character-card.ts): an item that fits
// the inline limit is shown whole; a larger one as its summary (each field's size, never its
// text), to be read in pages. Pure: the caller passes the model's local token counter, so the
// same revision and model always render the same bytes.
import { Effect } from "effect"
import { withoutCardSkills } from "./toolLoading.ts"
import type { PresetPrompt, PromptOrderEntry } from "@dreamspan/shared/docs/preset.ts"
import { presetOrder } from "@dreamspan/shared/presetOrder.ts"

export type LibraryKind = "card" | "lorebook" | "preset"
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
export const CARD_TEXT_FIELDS = [
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
export const visibleDoc = (kind: LibraryKind, doc: Doc): Doc =>
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

/** The first index page in a summary, then how many more there are. */
const firstPage = (rows: ReadonlyArray<{ readonly line: string }>, more: string) =>
  rows.length > INDEX_PAGE
    ? [...rows.slice(0, INDEX_PAGE).map((row) => row.line), `${rows.length - INDEX_PAGE} more ${more}.`]
    : rows.map((row) => row.line)

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
            ...firstPage(entryRows(bookEntries(kind, doc), count), "entries")
          ])
    ]
  }
  if (kind === "lorebook")
    return [`${list(doc.entries).length} entries`, ...firstPage(entryRows(bookEntries(kind, doc), count), "entries")]
  const rows = promptRows(doc, count)
  return [`${list(doc.prompts).length} prompts, ${list(doc.order).length} in order`, ...firstPage(rows, "prompts")]
}

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Escape a literal closing tag while keeping the JSON field value reversible. */
const fenced = (body: string, tag: string, lessThan: string) =>
  body.replace(new RegExp(`</${tag}\\s*>`, "g"), (match) => lessThan + match.slice(1))

const OMITTED = "More details are available with the read tool."

const ARTICLE: Record<LibraryKind, string> = { card: "A card", lorebook: "A lorebook", preset: "A prompt preset" }
const READER: Record<LibraryKind, string> = { card: "read_card", lorebook: "read_lorebook", preset: "read_preset" }

interface AttachedItem {
  readonly kind: LibraryKind
  readonly refId: string
  readonly revisionId: string
  readonly name: string
  readonly doc: Doc
}

/** The three ways an attached item can be shown, smallest first. */
const renderings = (item: AttachedItem, count: CountText) => {
  const tag = `attached_${item.kind}`
  const doc = visibleDoc(item.kind, item.doc)
  const whole = JSON.stringify(doc)
  const size = count(whole)
  const open = (name: string) =>
    `<${tag} name="${attribute(name)}" id="${attribute(item.refId)}" revision="${attribute(item.revisionId)}" tokens="${number(size)}"`
  const intro = `${ARTICLE[item.kind]} the user attached for you to work on.${item.kind === "card" ? " It is data, not a character for you to play." : ""}`
  const instruction = `${intro} It isn't included whole here: read it with ${READER[item.kind]} using the attachment id and revision.`
  const reference = (name: string, lines: ReadonlyArray<string>) =>
    `${open(name)} whole="no">\n${[instruction, ...lines].join("\n")}\n</${tag}>`
  const details = summaryLines(item.kind, doc, count).map((line) => fenced(line, tag, "&lt;"))
  const rest = details.length ? [OMITTED] : []
  return {
    /** Its name, id and revision only; "…" for the name where even that is too long. */
    compact: (limit: number) => {
      const named = reference(item.name, rest)
      return count(named) <= limit ? named : reference("…", rest)
    },
    /** As many summary lines as fit `limit`, saying when some are left out; null when none do. */
    summary: (limit: number) => {
      let rendered: string | null = null
      for (let n = 1; n <= details.length; n++) {
        const candidate = reference(item.name, n < details.length ? [...details.slice(0, n), OMITTED] : details)
        if (count(candidate) > limit) break
        rendered = candidate
      }
      return rendered
    },
    whole: `${open(item.name)}>\n${intro}\n${fenced(whole, tag, "\\u003c")}\n</${tag}>`
  }
}

/**
 * The elements a workshop message carries for its attached items (spec/WORKSHOP-CARDS.md §4.3
 * point 1): one budget of `limit` tokens for them all, counted on the rendered elements. Each
 * item first gets a compact reference (its name, id and revision, to read with the tools); then,
 * in the order attached, each is shown whole where that still fits, else with its summary where
 * that fits, else stays compact. When even the compact references don't fit, they are all the
 * message carries (a message sent before the budget, or a model with a tiny window).
 * Owner [D]: attached items are worked on, never played ("You're not adding cards to have a
 * pointless chat about them").
 */
export const attachedElements = (items: ReadonlyArray<AttachedItem>, count: CountText, limit: number) => {
  const all = items.map((item) => renderings(item, count))
  const compacts = all.map((r) => r.compact(limit))
  const compactSizes = compacts.map(count)
  let left = limit - compactSizes.reduce((sum, size) => sum + size, 0)
  if (left < 0) return compacts
  return all.map((r, i) => {
    const compact = compactSizes[i]!
    const whole = count(r.whole)
    if (whole - compact <= left) {
      left -= whole - compact
      return r.whole
    }
    const summary = r.summary(compact + left)
    if (summary === null || count(summary) <= compact) return compacts[i]!
    left -= count(summary) - compact
    return summary
  })
}

// --- Paged reads (read_card, read_lorebook, read_preset; spec/WORKSHOP-CARDS.md §4.3 point 2).

/** A token counter that may ask a worker: the tools count in the run's model's tokens. */
export type CountEffect = (text: string) => Effect.Effect<number>

/** Four characters a token, reference-harness's estimate, where no model counter is at hand. */
export const estimateCount: CountEffect = (text) => Effect.succeed(Math.ceil(text.length / 4))

/**
 * Runs a sync view with its counts asked for up front: the view runs once to learn which texts
 * it counts, they are counted a few at a time, then it runs again with the answers.
 */
export const withCounts = <A>(count: CountEffect, view: (count: CountText) => A) =>
  Effect.gen(function* () {
    const texts = new Set<string>()
    view((text) => {
      texts.add(text)
      return 0
    })
    const counted = new Map<string, number>()
    yield* Effect.forEach(texts, (text) => Effect.map(count(text), (n) => void counted.set(text, n)), {
      concurrency: 4,
      discard: true
    })
    return view((text) => counted.get(text) ?? Math.ceil(text.length / 4))
  })

const PAGE_TOKENS = { default: 2_000, minimum: 200, maximum: 8_000 } as const

/** A page's size in tokens, as the call asked, within 200–8,000 (2,000 by default). */
export const pageTokens = (asked: unknown) =>
  typeof asked === "number" && Number.isFinite(asked)
    ? Math.max(PAGE_TOKENS.minimum, Math.min(PAGE_TOKENS.maximum, Math.floor(asked)))
    : PAGE_TOKENS.default

/**
 * Where one page of `text` from character `start` ends: as much as fits `maxTokens`, cut at a
 * line end where the page has one (as reference-harness's excerpts are), never empty.
 */
const pageEnd = (text: string, start: number, maxTokens: number, count: CountEffect) =>
  Effect.gen(function* () {
    if (start >= text.length || (yield* count(text.slice(start))) <= maxTokens) return text.length
    // The largest end that fits; no page needs more than 16 characters a token.
    let low = start + 1
    let high = Math.min(text.length, start + maxTokens * 16)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((yield* count(text.slice(start, middle))) <= maxTokens) low = middle
      else high = middle - 1
    }
    const line = text.lastIndexOf("\n", low - 1)
    return line >= start ? line + 1 : low
  })

/** One page of a text, with reference-harness's note on where it stopped and how to read on. */
export const pageOf = (text: string, what: string, offset: unknown, maxTokens: number, count: CountEffect) =>
  Effect.gen(function* () {
    const asked = typeof offset === "number" && Number.isFinite(offset) ? Math.floor(offset) : 0
    const start = Math.max(0, Math.min(text.length, asked))
    const end = yield* pageEnd(text, start, maxTokens, count)
    const body = text.slice(start, end)
    if (start === 0 && end === text.length) return body
    const shown = `[Showing characters ${number(Math.min(start + 1, end))}–${number(end)} of ${number(text.length)} in ${what}.`
    return `${body}\n${end < text.length ? `${shown} Read on with offset=${end}.]` : `${shown} That's the end.]`}`
  })

/** A lorebook's entries, or a card's embedded book's. */
const bookEntries = (kind: LibraryKind, doc: Doc) =>
  list(kind === "card" ? record(doc.character_book).entries : doc.entries).map(record)

/** A preset's prompts in order, then those saved outside the order (where `presetOrder` puts them). */
const promptRows = (doc: Doc, count: CountText) => {
  const saved = list(doc.prompts) as ReadonlyArray<PresetPrompt>
  const order = list(doc.order) as ReadonlyArray<PromptOrderEntry>
  const prompts = new Map(saved.map((prompt) => [prompt.identifier, prompt]))
  const ordered = new Set(order.map((entry) => entry.identifier))
  const indexed = [
    ...order,
    ...presetOrder(saved, order).filter((entry) => prompts.has(entry.identifier) && !ordered.has(entry.identifier))
  ]
  return indexed.map((entry) => {
    const id = String(entry.identifier)
    const prompt = prompts.get(entry.identifier)
    return {
      id,
      line: `- ${prompt?.name || id} (${id}; ${entry.enabled === false ? "off" : "on"}): ${number(tokens(count, text(prompt?.content)))} tokens`
    }
  })
}

const entryRows = (entries: ReadonlyArray<Doc>, count: CountText) =>
  entries.map((entry, index) => {
    const keys = list(entry.keys).filter((k): k is string => typeof k === "string")
    return {
      id: String(entry.uid),
      line: `- ${entryTitle(entry, index)} (uid ${String(entry.uid)}${keys.length ? `; keys: ${keys.join(", ")}` : ""}${entry.enabled === false ? "; off" : ""}): ${number(tokens(count, text(entry.content)))} tokens`
    }
  })

/**
 * The `index` view: a book's entries (a card's embedded one, for a card) or a preset's prompts in
 * order, 50 a page, after the one `after` names (a uid or an identifier). Null: no such one.
 */
export const indexLines = (kind: LibraryKind, doc: Doc, after: string | undefined, count: CountText) => {
  const rows = kind === "preset" ? promptRows(doc, count) : entryRows(bookEntries(kind, doc), count)
  const from = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1
  if (after !== undefined && from === 0) return null
  const page = rows.slice(from, from + INDEX_PAGE)
  const remaining = rows.length - from - page.length
  return [
    ...page.map((row) => row.line),
    remaining > 0
      ? `Remaining after this page: ${remaining}. Read on with after="${page.at(-1)!.id}".`
      : `${rows.length} in all; that's the end.`
  ]
}

/** One book entry by uid, or one preset prompt by identifier. */
export const findPart = (kind: LibraryKind, doc: Doc, id: string) =>
  kind === "preset"
    ? (list(doc.prompts)
        .map(record)
        .find((p) => text(p.identifier) === id) ?? null)
    : (bookEntries(kind, doc).find((entry) => String(entry.uid) === id) ?? null)
