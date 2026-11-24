// Finding a message among all of the user's chats (DESIGN §10.1; ST-COMPARISON item 21: "which
// chat had this scene?"). A hit is one message version, the text as written, with the branches
// that show it: a message every branch shares is one hit, not one per branch. What the words
// are, how a text's matches are marked and the excerpt shown are here, so the server and the
// client agree on them.
import { Schema } from "effect"
import { ChatId, EntityId, ForkId, ForkSplit, SlotId, VersionId } from "./chat.ts"

/**
 * What's typed: words, each found as the start of a word in a message, in any order; words in
 * quotes, a phrase found exactly as written.
 */
export const MessageQuery = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(200))

/** Words at most; the rest of a long query is left out. */
const MAX_WORDS = 8

/** A text's words as the full-text index splits it (letters and digits; everything else separates), lower case. */
const tokens = (text: string): ReadonlyArray<string> =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []

/**
 * A query's parts: phrases in quotes ("…" or “…”; an unclosed quote runs to the end), each its
 * words in order, found exactly as written; and the words outside them in the order typed,
 * without repeats, each found as the start of a word. At most MAX_WORDS words in all.
 */
export interface ParsedQuery {
  readonly phrases: ReadonlyArray<ReadonlyArray<string>>
  readonly words: ReadonlyArray<string>
}

export const parseQuery = (query: string): ParsedQuery => {
  const phrases: Array<Array<string>> = []
  const words: Array<string> = []
  let budget = MAX_WORDS
  const parts = query.split(/["“”„]/)
  parts.forEach((part, i) => {
    const found = tokens(part)
    if (i % 2 === 1) {
      const phrase = found.slice(0, budget)
      if (phrase.length > 0) phrases.push(phrase)
      budget -= phrase.length
    } else {
      const fresh = found.filter((word, k) => !words.includes(word) && found.indexOf(word) === k)
      words.push(...fresh.slice(0, budget))
      budget -= Math.min(budget, fresh.length)
    }
  })
  return { phrases, words }
}

/** Every word a query looks for, without repeats: what marks a found message's text. */
export const queryWords = (query: string): ReadonlyArray<string> => {
  const { phrases, words } = parseQuery(query)
  return [...new Set([...phrases.flat(), ...words])]
}

/**
 * The phrase a found message is shown around: the query's first quoted phrase, else its words
 * in the order typed when there are two or more (a match with them side by side ranks first).
 */
export const focusPhrase = (query: string): ReadonlyArray<string> | null => {
  const { phrases, words } = parseQuery(query)
  return phrases[0] ?? (words.length >= 2 ? words : null)
}

/** A text's letters with case and accents folded away, as the index compares them. */
const fold = (char: string) => char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

export interface Mark {
  readonly at: number
  readonly length: number
}

/** Folded text with each folded unit's offset in the original (one past the end last). */
const foldText = (text: string) => {
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
  return { folded, origin }
}

const isWord = /[\p{L}\p{N}]/u

/**
 * Where `phrase` first stands in `text` (a UTF-16 offset), its words side by side in order,
 * each the start of a word of the text with only spaces or punctuation between; null without.
 */
export const findPhrase = (text: string, phrase: ReadonlyArray<string>): number | null => {
  if (phrase.length === 0) return null
  const { folded, origin } = foldText(text)
  const targets = phrase.map(fold)
  // The text's words: where each starts and ends in the folded text.
  const starts: Array<number> = []
  const ends: Array<number> = []
  for (let i = 0; i < folded.length; i++) {
    if (!isWord.test(folded[i]!) || (i > 0 && isWord.test(folded[i - 1]!))) continue
    let end = i + 1
    while (end < folded.length && isWord.test(folded[end]!)) end++
    starts.push(i)
    ends.push(end)
    i = end - 1
  }
  for (let w = 0; w + targets.length <= starts.length; w++) {
    if (targets.every((target, k) => folded.slice(starts[w + k]!, ends[w + k]!).startsWith(target)))
      return origin[starts[w]!]!
  }
  return null
}

/**
 * Where `words` start words of `text` (UTF-16 offsets into it), earliest first and not
 * overlapping: each word matches where a word of the text starts with it, ignoring case and
 * accents, as the index matched it.
 */
export const markWords = (text: string, words: ReadonlyArray<string>): ReadonlyArray<Mark> => {
  if (words.length === 0) return []
  const { folded, origin } = foldText(text)
  const targets = words.map(fold)
  const marks: Array<Mark> = []
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

/**
 * The part of `text` around its first match, with the matches in it marked; its start without
 * one. With `phrase`, around where that phrase first stands, when it does.
 */
export const excerpt = (
  text: string,
  words: ReadonlyArray<string>,
  length = EXCERPT_LENGTH,
  phrase: ReadonlyArray<string> | null = null
): Excerpt => {
  const flat = text.replace(/\s+/g, " ")
  const marks = markWords(flat, words)
  const first = (phrase === null ? null : findPhrase(flat, phrase)) ?? marks[0]?.at ?? 0
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

/**
 * Where the next page starts: past this version in the sort's order (below it newest first,
 * above it oldest first). `phase` "words": among the messages that have the words apart, after
 * every one that has them side by side (Best match). `chat`: the Chat sort's place in its list
 * of chats, `before` within that chat. `chatOrder` identifies the list that gave it that place.
 */
export const MessageCursor = Schema.Struct({
  before: Schema.Int,
  phase: Schema.optionalKey(Schema.Literal("words")),
  chat: Schema.optionalKey(Schema.Int),
  chatOrder: Schema.optionalKey(Schema.String)
})
export type MessageCursor = typeof MessageCursor.Type

/**
 * How found messages are listed: Best match (words side by side first, then apart, each newest
 * first), Newest, Oldest, or Chat (by chat name, A to Z unless reversed, newest first in each).
 */
export const MESSAGE_SORTS = ["best", "newest", "oldest", "chat"] as const
export const MessageSort = Schema.Literals(MESSAGE_SORTS)
export type MessageSort = typeof MessageSort.Type

/** Found messages counted at most; past it the count says "1,000+". */
export const MESSAGE_COUNT_CAP = 1000

/**
 * How many messages have the words, and in how many chats. `more`: the count stopped early, at
 * MESSAGE_COUNT_CAP or after the matches a count reads at most, so there are more than `messages`.
 */
export const MessageCount = Schema.Struct({ messages: Schema.Int, chats: Schema.Int, more: Schema.Boolean })
export type MessageCount = typeof MessageCount.Type

/** "128 messages in 14 chats", or "1,000+ messages" when the count stopped early. */
export const messageCountText = ({ messages, chats, more }: MessageCount) => {
  const n = `${messages.toLocaleString("en-US")}${more ? "+" : ""} message${messages === 1 && !more ? "" : "s"}`
  return more ? n : `${n} in ${chats.toLocaleString("en-US")} chat${chats === 1 ? "" : "s"}`
}

export const MessageSearchPage = Schema.Struct({
  hits: Schema.Array(MessageHit),
  /** This is a fresh first page because the cursor's chat order changed. */
  restarted: Schema.optionalKey(Schema.Literal(true)),
  /** Null when nothing older is left. */
  next: Schema.NullOr(MessageCursor)
})
export type MessageSearchPage = typeof MessageSearchPage.Type

/** Hits a page holds at most. */
export const MESSAGE_PAGE = 20
