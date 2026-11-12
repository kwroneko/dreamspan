// Finding a message among all of the user's chats (DESIGN §10.1; ST-COMPARISON item 21: "which
// chat had this scene?"). A hit is one message version, the text as written, with the branches
// that show it: a message every branch shares is one hit, not one per branch. What the words
// are, how a text's matches are marked and the excerpt shown are here, so the server and the
// client agree on them.
import { Schema } from "effect"
import { ChatId, EntityId, ForkId, ForkSplit, SlotId, VersionId } from "./chat.ts"

/** What's typed: words, each found as the start of a word in a message, in any order. */
export const MessageQuery = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(200))

/** Words at most; the rest of a long query is left out. */
const MAX_WORDS = 8

/**
 * The words of a query, as the full-text index splits text (letters and digits; everything
 * else separates), lower case, without repeats.
 */
export const queryWords = (query: string): ReadonlyArray<string> => [
  ...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 0).slice(0, MAX_WORDS))
]

/** A text's letters with case and accents folded away, as the index compares them. */
const fold = (char: string) => char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

export interface Mark {
  readonly at: number
  readonly length: number
}

/**
 * Where `words` start words of `text` (UTF-16 offsets into it), earliest first and not
 * overlapping: each word matches where a word of the text starts with it, ignoring case and
 * accents, as the index matched it.
 */
export const markWords = (text: string, words: ReadonlyArray<string>): ReadonlyArray<Mark> => {
  if (words.length === 0) return []
  // Folded text with each folded unit's offset in the original.
  let folded = ""
  const origin: Array<number> = []
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i)!
    const char = String.fromCodePoint(code)
    const f = fold(char)
    for (let k = 0; k < f.length; k++) origin.push(i)
    folded += f
    i += char.length
  }
  origin.push(text.length)
  const targets = words.map(fold)
  const marks: Array<Mark> = []
  const isWord = /[\p{L}\p{N}]/u
  for (let i = 0; i < folded.length; i++) {
    if (i > 0 && isWord.test(folded[i - 1]!)) continue
    if (!isWord.test(folded[i]!)) continue
    const word = targets.find((t) => folded.startsWith(t, i))
    if (word === undefined) continue
    const start = origin[i]!
    // The whole word of the text, so a prefix marks the word it starts.
    let end = i + word.length
    while (end < folded.length && isWord.test(folded[end]!)) end++
    marks.push({ at: start, length: origin[end]! - start })
    i = end - 1
  }
  return marks
}

/** Characters an excerpt shows at most. */
const EXCERPT_LENGTH = 180

export const Excerpt = Schema.Struct({
  text: Schema.String,
  /** The matches in `text`. */
  marks: Schema.Array(Schema.Struct({ at: Schema.Int, length: Schema.Int })),
  /** Text was left out before or after it. */
  before: Schema.Boolean,
  after: Schema.Boolean
})
export type Excerpt = typeof Excerpt.Type

/** The part of `text` around its first match, with the matches in it marked; its start without one. */
export const excerpt = (text: string, words: ReadonlyArray<string>, length = EXCERPT_LENGTH): Excerpt => {
  const flat = text.replace(/\s+/g, " ")
  const marks = markWords(flat, words)
  const first = marks[0]?.at ?? 0
  let start = Math.max(0, first - Math.floor(length / 3))
  // Start at a word, unless that's far back.
  if (start > 0) {
    const space = flat.lastIndexOf(" ", start)
    if (space >= 0 && start - space < 20) start = space + 1
  }
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(flat[start]!)) start++
  let end = Math.min(flat.length, start + length)
  if (end < flat.length && /[\uDC00-\uDFFF]/.test(flat[end]!)) end++
  return {
    text: flat.slice(start, end),
    marks: marks
      .filter((m) => m.at >= start && m.at < end)
      .map((m) => ({ at: m.at - start, length: Math.min(m.length, end - m.at) })),
    before: start > 0,
    after: end < flat.length
  }
}

/** A branch a hit is shown on, with what names it (`forkLabel` on the client). */
export const HitBranch = Schema.Struct({
  forkId: ForkId,
  name: Schema.NullOr(Schema.String),
  original: Schema.Boolean,
  split: Schema.NullOr(ForkSplit),
  createdAt: Schema.Number,
  /** The chat opens on it. */
  current: Schema.Boolean
})
export type HitBranch = typeof HitBranch.Type

/** Branches a hit names at most; `branchCount` counts them all. */
export const HIT_BRANCHES = 3

/**
 * One message version that has the words, on the branches that show it. `branches` are the
 * first few of them, the one to open first (the chat's current branch when it shows it, else
 * the one chatted in last); `branchCount` is how many show it.
 */
export const MessageHit = Schema.Struct({
  versionId: VersionId,
  slotId: SlotId,
  chatId: ChatId,
  chatName: Schema.String,
  /** The speaker's card; null for a message without one. */
  speakerEntityId: Schema.NullOr(EntityId),
  /** Who wrote it as the timeline names them: a card's name, else "You" or "Model". */
  speaker: Schema.String,
  /** Its number on the first branch, from 1. */
  position: Schema.Int,
  createdAt: Schema.Number,
  excerpt: Excerpt,
  branches: Schema.Array(HitBranch),
  branchCount: Schema.Int
})
export type MessageHit = typeof MessageHit.Type

/** Where the next page starts: below this version (newest first). */
export const MessageCursor = Schema.Struct({ before: Schema.Int })
export type MessageCursor = typeof MessageCursor.Type

export const MessageSearchPage = Schema.Struct({
  hits: Schema.Array(MessageHit),
  /** Null when nothing older is left. */
  next: Schema.NullOr(MessageCursor)
})
export type MessageSearchPage = typeof MessageSearchPage.Type

/** Hits a page holds at most. */
export const MESSAGE_PAGE = 20
