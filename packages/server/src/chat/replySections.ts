// Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): the registered reply
// parser that takes a leading `<think>…</think>` section out of the streamed body. It runs on
// the main thread over each chunk as it arrives; its patterns are compiled by the assembler's
// linear-time engine, so no text can make a match slow.
import {
  type ReplySection,
  type ReplySections,
  type ReplySectionSettings,
  sectionUnclosed
} from "@rp/shared/replySections.ts"
import { Stream } from "effect"
import type { Generation } from "../assembler/types.ts"
import { compileLinear } from "../assembler/regex.ts"
import type { GenerationChunk, GenerationFailed, GenerationRequest } from "./Generator.ts"

/** The longest tag a stream can split: the text held back while one may be starting. */
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
  readonly caseless: boolean
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

/** The usable pairs: both patterns compile, safely, and neither matches empty text. */
export const compilePairs = (settings: ReplySectionSettings): ReadonlyArray<Pair> =>
  settings.pairs.flatMap((pair) => {
    const caseless = pair.case_sensitive !== true
    const flags = caseless ? "i" : ""
    const open = compileLinear(`^(?:${pair.open})`, flags)
    const close = compileLinear(pair.close, `g${flags}`)
    if (!(open instanceof RegExp) || !(close instanceof RegExp) || pair.open === "" || pair.close === "") return []
    close.lastIndex = 0
    if (open.test("") || close.test("")) return []
    return [{ open, close, first: firstLiteral(pair.open), caseless }]
  })

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
  const hold = (into: "body" | "section") => {
    if (buffer === lastHeld) return
    lastHeld = buffer
    out.push({ held: buffer, into })
  }
  const setLast = (change: Partial<ReplySection>) => {
    sections = [...sections.slice(0, -1), { ...sections.at(-1)!, ...change }]
  }

  /** Whether the start of `rest` may still become an opening tag. */
  const mayOpen = (rest: string) =>
    rest.length < TAG_HOLD &&
    !rest.includes("\n") &&
    pairs.some(
      (pair) =>
        pair.first === null ||
        (pair.caseless ? rest[0]!.toLowerCase() === pair.first.toLowerCase() : rest[0] === pair.first)
    )

  const opening = (rest: string) => {
    for (const pair of pairs) {
      const match = pair.open.exec(rest)
      if (match && match[0] !== "") return { pair, tag: match[0] }
    }
    return null
  }

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
    if (rest !== "") {
      const open = opening(rest)
      if (open) {
        sections = [...sections, { lead, open: open.tag, text: "", close: null }]
        closing = open.pair
        state = "inside"
        buffer = rest.slice(open.tag.length)
        emitSections(sections.length > 1 ? "\n\n" : "")
        return inside(final)
      }
    }
    if (!final && (rest === "" || mayOpen(rest))) return hold("body")
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
    const shown = final ? buffer.length : Math.max(0, buffer.length - TAG_HOLD)
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
    const lead = /^\s*/.exec(prefill)![0]
    const open = opening(prefill.slice(lead.length))
    const rest = open ? prefill.slice(lead.length + open.tag.length) : ""
    if (open && !findCloseIn(open.pair, rest)) {
      sections = [{ lead, open: open.tag, text: rest, close: null, prefilled: prefill.length }]
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
export const throughParse = <R>(stream: Stream.Stream<GenerationChunk, GenerationFailed, R>, parse: ReplyParse) =>
  stream.pipe(
    Stream.map(parse.push),
    Stream.flattenIterable,
    Stream.concat(Stream.suspend(() => Stream.fromIterable(parse.end())))
  )
