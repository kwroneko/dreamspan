// Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): the registered reply
// parser that takes a leading `<think>…</think>` section out of the streamed body. It runs on
// the main thread over each chunk as it arrives; its patterns are compiled by the assembler's
// linear-time engine, so no text can make a match slow.
import {
  type ReplySection,
  type ReplySections,
  type ReplySectionSettings,
  literalPattern,
  sectionUnclosed
} from "@rp/shared/replySections.ts"
import { Stream } from "effect"
import type { Generation } from "../assembler/types.ts"
import { compileLinear } from "../assembler/regex.ts"
import type { GenerationChunk, GenerationFailed, GenerationRequest } from "./Generator.ts"

/**
 * The longest regex tag a stream can split: the text held back while one may be starting.
 * A literal tag is held exactly, at any length.
 */
const TAG_HOLD = 64

export interface ReplyParse {
  /** What one chunk of the reply becomes. */
  readonly push: (chunk: GenerationChunk) => ReadonlyArray<GenerationChunk>
  /** At the end of a reply that finished on its own: what it still held back. */
  readonly end: () => ReadonlyArray<GenerationChunk>
}

/** A stage the reply's chunks go through (`ExecutionRegistry.replyParsers`), in registration order. */
export interface ReplyParser {
  readonly id: string
  /** A fresh parse per generation; null when it doesn't apply to this one. */
  readonly create: (input: {
    readonly request: GenerationRequest
    readonly generation: Generation
  }) => ReplyParse | null
}

interface Pair {
  /** Anchored at the start of the text it's run on. */
  readonly open: RegExp
  readonly close: RegExp
  /** The opening pattern's first character when it's a plain one, to rule a text out early. */
  readonly first: string | null
  /** The closing pattern's, so a section's text shows up to where its closing tag may start. */
  readonly closeFirst: string | null
  readonly caseless: boolean
  /** A literal pair's tags as written (the default; null: a regex pair), so a hold is exact. */
  readonly literal: { readonly open: string; readonly close: string; readonly leading: number } | null
}

/** A pattern's first character when it's a literal one every match starts with. */
const firstLiteral = (pattern: string) => {
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") i++
    else if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "|" && depth === 0) return null
  }
  let char: string | undefined
  let next: number
  if (pattern[0] === "\\") {
    char = pattern[1]
    if (char === undefined || /[0-9A-Za-z]/.test(char)) return null
    next = 2
  } else {
    char = pattern[0]
    if (char === undefined || "^$.*+?()[]{}|".includes(char)) return null
    next = 1
  }
  return "?*{".includes(pattern[next] ?? "") ? null : char
}

/**
 * The usable pairs: both patterns compile, safely, and neither matches empty text. A pair's
 * tags are literal text unless it opts into regular expressions (`regex`, owner 2026-11-02),
 * so `<think|plan>` or `[plan.*]` match only as written.
 */
export const compilePairs = (settings: ReplySectionSettings): ReadonlyArray<Pair> =>
  settings.pairs.flatMap((pair) => {
    if (pair.open === "" || pair.close === "") return []
    const regex = pair.regex === true
    const openPattern = regex ? pair.open : literalPattern(pair.open)
    const closePattern = regex ? pair.close : literalPattern(pair.close)
    const caseless = pair.case_sensitive !== true
    const flags = caseless ? "i" : ""
    const open = compileLinear(`^(?:${openPattern})`, flags)
    const close = compileLinear(closePattern, `g${flags}`)
    if (!(open instanceof RegExp) || !(close instanceof RegExp)) return []
    close.lastIndex = 0
    if (open.test("") || close.test("")) return []
    return [
      {
        open,
        close,
        first: firstLiteral(openPattern),
        closeFirst: firstLiteral(closePattern),
        caseless,
        literal: regex ? null : { open: pair.open, close: pair.close, leading: /^\s*/.exec(pair.open)![0].length }
      }
    ]
  })

/** Whether `text` is how `tag` begins, in the pair's case rule. */
const beginsTag = (tag: string, text: string, caseless: boolean) => {
  if (text.length > tag.length) return false
  for (let i = 0; i < text.length; i++)
    if (caseless ? text[i]!.toLowerCase() !== tag[i]!.toLowerCase() : text[i] !== tag[i]) return false
  return true
}

/** Where held text went when a reply ended without the parser's end: a stop, a crash, a failure. */
export const settleHeld = (
  text: string,
  sections: ReplySections | null,
  held: { readonly held: string; readonly into: "body" | "section" } | null
): { readonly text: string; readonly sections: ReplySections | null } => {
  if (!held || held.held === "") return { text, sections }
  const last = sections?.sections.at(-1)
  if (held.into === "section" && sections && last)
    return {
      text,
      sections: { ...sections, sections: [...sections.sections.slice(0, -1), { ...last, text: last.text + held.held }] }
    }
  return { text: text + held.held, sections }
}

type State = "lead" | "inside" | "after" | "body"

const findCloseIn = (pair: Pair, text: string) => {
  pair.close.lastIndex = 0
  const match = pair.close.exec(text)
  return match !== null && match[0] !== ""
}

/** The parse of one reply with these pairs, from where `initial` (a continued version) left off. */
export const parseReply = (
  pairs: ReadonlyArray<Pair>,
  initial: { readonly text: string; readonly sections?: ReplySections | undefined } | undefined,
  prefill: string | null
): ReplyParse => {
  let sections: Array<ReplySection> = [...(initial?.sections?.sections ?? [])]
  let gap = initial?.sections?.gap ?? ""
  let state: State = !initial ? "lead" : sectionUnclosed(initial.sections) ? "inside" : "body"
  /** The pair whose closing tag ends the open section; null: any pair's. */
  let closing: Pair | null = null
  let buffer = ""
  let lastHeld = ""

  const snapshot = (): ReplySections => ({ sections, gap })
  const out: Array<GenerationChunk> = []
  const emitSections = (text: string) => out.push({ sections: snapshot(), text })
  let lastInto: "body" | "section" = "body"
  const hold = (into: "body" | "section") => {
    if (buffer === lastHeld && into === lastInto) return
    lastHeld = buffer
    lastInto = into
    out.push({ held: buffer, into })
  }
  const setLast = (change: Partial<ReplySection>) => {
    sections = [...sections.slice(0, -1), { ...sections.at(-1)!, ...change }]
  }

  const startsWith = (pair: Pair, first: string, c: string) =>
    pair.caseless ? c.toLowerCase() === first.toLowerCase() : c === first

  /**
   * Whether the start of `rest` may still become an opening tag: exactly, for a literal tag
   * (`<b>` goes through at once); for a pattern, while it's short, on one line and allowed
   * by the pattern's plain first character.
   */
  const mayOpen = (text: string, lead: string) =>
    pairs.some((pair) => {
      if (pair.literal) {
        // Only the whitespace before the tag is optional; its own whitespace is literal.
        const at = lead.length - pair.literal.leading
        return at >= 0 && beginsTag(pair.literal.open, text.slice(at), pair.caseless)
      }
      const possible = (rest: string) =>
        rest.length < TAG_HOLD &&
        !rest.includes("\n") &&
        (pair.first === null || startsWith(pair, pair.first, rest[0]!))
      return possible(text.slice(lead.length)) || (lead !== "" && possible(text))
    })

  /** A complete opening tag, keeping its own whitespace separate from the optional lead. */
  const opening = (text: string) => {
    // Prefer a tag at the start, including one made entirely of whitespace.
    for (const pair of pairs) {
      const match = pair.open.exec(text)
      if (match && match[0] !== "") return { pair, tag: match[0], lead: "" }
    }
    const lead = /^\s*/.exec(text)![0]
    for (const pair of pairs) {
      const at = pair.literal ? lead.length - pair.literal.leading : lead.length
      if (at <= 0) continue
      const match = pair.open.exec(text.slice(at))
      if (match && match[0] !== "") return { pair, tag: match[0], lead: text.slice(0, at) }
    }
    return null
  }

  /**
   * Where a closing tag may be starting in the text not shown yet, so the panel keeps up with
   * the stream: for a literal tag, the earliest tail that begins it (`</thi` waits, `a < b`
   * doesn't); for a pattern, the first character in the last `TAG_HOLD` that its plain first
   * character allows, or all of them when it has none.
   */
  const closeMayStartAt = (pair: Pair, text: string) => {
    if (pair.literal) {
      for (let i = Math.max(0, text.length - pair.literal.close.length + 1); i < text.length; i++)
        if (beginsTag(pair.literal.close, text.slice(i), pair.caseless)) return i
      return text.length
    }
    const from = Math.max(0, text.length - TAG_HOLD)
    if (pair.closeFirst === null) return from
    for (let i = from; i < text.length; i++) if (startsWith(pair, pair.closeFirst, text[i]!)) return i
    return text.length
  }
  const mayCloseAt = (text: string) =>
    Math.min(text.length, ...(closing ? [closing] : pairs).map((pair) => closeMayStartAt(pair, text)))

  const findClose = (text: string) => {
    let best: { index: number; tag: string } | null = null
    for (const pair of closing ? [closing] : pairs) {
      pair.close.lastIndex = 0
      const match = pair.close.exec(text)
      if (match && match[0] !== "" && (best === null || match.index < best.index))
        best = { index: match.index, tag: match[0] }
    }
    return best
  }

  /** Lead or after: whitespace, then an opening tag or the body. */
  const beforeSection = (final: boolean) => {
    const lead = /^\s*/.exec(buffer)![0]
    const rest = buffer.slice(lead.length)
    const open = opening(buffer)
    if (open) {
      sections = [...sections, { lead: open.lead, open: open.tag, text: "", close: null }]
      closing = open.pair
      state = "inside"
      buffer = buffer.slice(open.lead.length + open.tag.length)
      emitSections(sections.length > 1 ? "\n\n" : "")
      return inside(final)
    }
    if (!final && (rest === "" || mayOpen(buffer, lead))) return hold("body")
    // No section here: the body starts. After a section, the whitespace before it is the gap.
    if (state === "after") {
      gap = lead
      emitSections("")
      buffer = rest
    }
    state = "body"
    if (buffer !== "") out.push(buffer)
    buffer = ""
    hold("body")
  }

  /** Inside a section: its text, up to its closing tag. */
  const inside = (final: boolean): void => {
    const close = findClose(buffer)
    if (close) {
      const text = buffer.slice(0, close.index)
      setLast({ text: sections.at(-1)!.text + text, close: close.tag })
      buffer = buffer.slice(close.index + close.tag.length)
      state = "after"
      closing = null
      emitSections(text)
      return beforeSection(final)
    }
    const shown = final ? buffer.length : mayCloseAt(buffer)
    if (shown > 0) {
      const text = buffer.slice(0, shown)
      setLast({ text: sections.at(-1)!.text + text })
      buffer = buffer.slice(shown)
      emitSections(text)
    }
    hold("section")
  }

  const feed = (text: string, final: boolean) => {
    if (state === "body") {
      if (text !== "") out.push(text)
      return
    }
    buffer += text
    if (state === "inside") inside(final)
    else beforeSection(final)
  }

  // A preset prefill that opens a section ("Start reply with" `<thinking>`): the reply starts in it.
  if (!initial && prefill) {
    const open = opening(prefill)
    const rest = open ? prefill.slice(open.lead.length + open.tag.length) : ""
    if (open && !findCloseIn(open.pair, rest)) {
      sections = [{ lead: open.lead, open: open.tag, text: rest, close: null, prefilled: prefill.length }]
      closing = open.pair
      state = "inside"
    }
  }
  // The prefilled section is announced with the first chunk, its text so far in the panel.
  let announce = state === "inside" && !initial
  const drain = () => out.splice(0, out.length)
  const step = (run: () => void) => {
    if (announce) emitSections(sections[0]!.text)
    announce = false
    run()
    return drain()
  }
  return {
    push: (chunk) => step(() => (typeof chunk === "string" ? feed(chunk, false) : out.push(chunk))),
    end: () => step(() => feed("", true))
  }
}

/** The built-in parser: the preset's pattern pairs, when it has them switched on. */
export const replySectionsParser: ReplyParser = {
  id: "reply-sections",
  create: ({ request, generation }) => {
    const settings = generation.replySections
    if (!settings?.enabled) return null
    const pairs = compilePairs(settings)
    if (pairs.length === 0) return null
    return parseReply(pairs, request.initial, request.initial ? null : generation.request.prefill)
  }
}

/** The reply's chunks through one parse; it flushes when the reply finishes on its own. */
export const throughParse = <R>(
  stream: Stream.Stream<GenerationChunk, GenerationFailed, R>,
  parse: ReplyParse,
  /** A fresh parse for when the reply starts over (`restart`); without it, the same one goes on. */
  fresh?: () => ReplyParse
) => {
  let current = parse
  return stream.pipe(
    Stream.map((chunk): ReadonlyArray<GenerationChunk> => {
      if (typeof chunk === "object" && "restart" in chunk && fresh) {
        // What it held back belonged to the text that wasn't the reply.
        current = fresh()
        return [chunk]
      }
      if (typeof chunk === "object" && "post" in chunk) {
        const tail = current.end()
        if (fresh) current = fresh()
        return [...tail, chunk]
      }
      return current.push(chunk)
    }),
    Stream.flattenIterable,
    Stream.concat(Stream.suspend(() => Stream.fromIterable(current.end())))
  )
}
