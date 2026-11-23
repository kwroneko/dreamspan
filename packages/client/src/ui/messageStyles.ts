// What the message editor styles in the text being edited: the ranges of the stored text that
// the message renders as dialogue, italics, bold, underline and the rest, and the Markdown marks
// around them (dimmed in the editor, where they stay text). They come from the renderer's own
// steps (stFormatting.ts, stPipeline.ts): the same display fixes, the same blocks, each parsed
// with the same remark plugins, the dialogue matched by the same rule. Nothing here decides on
// its own what is dialogue or emphasis, so the editor and the message can't disagree.
//
// A block's styles are kept by its text: an edit reparses only the block it touched.
import remarkParse from "remark-parse"
import { unified } from "unified"
import { fixMarkdownRuns } from "./stFormatting.ts"
import { stBlocks, stHtmlRemarkPlugins, stRemarkPlugins } from "./stPipeline.ts"
import type { SourceRun } from "./sourcePositions.ts"

/** What a range is styled as; `syntax` is a Markdown mark, which renders as nothing. */
export const STYLE_KINDS = [
  "quote",
  "em",
  "strong",
  "underline",
  "strike",
  "code",
  "link",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "pre",
  "syntax"
] as const
export type StyleKind = (typeof STYLE_KINDS)[number]
const KIND = Object.fromEntries(STYLE_KINDS.map((kind, i) => [kind, i])) as Record<StyleKind, number>

export interface StyleOptions {
  /** "Show HTML as formatting": raw HTML is HTML, not prose (stFormatting's `html`). */
  readonly html?: boolean
}

/**
 * The styled ranges of `text`, as flat triples (from, to, kind index into STYLE_KINDS), sorted
 * by `from`, then the longer first: where two marks nest, the outer comes first.
 */
export type StyleRanges = Int32Array

interface MdNode {
  type: string
  depth?: number
  children?: MdNode[]
  data?: { hName?: string }
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const plain = unified().use(remarkParse).use(stRemarkPlugins)
const withHtml = unified().use(remarkParse).use(stHtmlRemarkPlugins)

/** Where a node is in its block: its own position, else the span of its children (a quote). */
function spanOf(node: MdNode): [number, number] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start !== undefined && end !== undefined) return [start, end]
  let from = Infinity
  let to = -Infinity
  for (const child of node.children ?? []) {
    const span = spanOf(child)
    if (!span) continue
    from = Math.min(from, span[0])
    to = Math.max(to, span[1])
  }
  return from < to ? [from, to] : null
}

/** The span of a node's children, for the marks either side of them. */
function innerOf(node: MdNode): [number, number] | null {
  let from = Infinity
  let to = -Infinity
  for (const child of node.children ?? []) {
    const span = spanOf(child)
    if (!span) continue
    from = Math.min(from, span[0])
    to = Math.max(to, span[1])
  }
  return from <= to ? [from, to] : null
}

/** One block's ranges, in the block's own offsets. */
function blockRanges(block: string, html: boolean): number[] {
  const processor = html ? withHtml : plain
  const tree = processor.runSync(processor.parse(block), block) as unknown as MdNode
  const out: number[] = []
  const push = (from: number, to: number, kind: StyleKind) => {
    if (to > from) out.push(from, to, KIND[kind])
  }
  /** The marks around a node's children: `*`, `**`, `~~`, `[` and `](…)`. */
  const around = (node: MdNode, [from, to]: [number, number]) => {
    const inner = innerOf(node)
    if (!inner) return push(from, to, "syntax")
    push(from, inner[0], "syntax")
    push(inner[1], to, "syntax")
  }
  const visit = (node: MdNode) => {
    const span = spanOf(node)
    if (span) {
      const [from, to] = span
      switch (node.type) {
        case "stQuote":
          push(from, to, "quote")
          break
        case "emphasis":
          push(from, to, "em")
          around(node, span)
          break
        case "strong":
          // `__x__` renders as underline (stFormatting's `ins`).
          push(from, to, node.data?.hName === "ins" ? "underline" : "strong")
          around(node, span)
          break
        case "delete":
          push(from, to, "strike")
          around(node, span)
          break
        case "inlineCode": {
          push(from, to, "code")
          const raw = block.slice(from, to)
          const fence = /^`+/.exec(raw)?.[0].length ?? 0
          push(from, from + fence, "syntax")
          push(to - fence, to, "syntax")
          break
        }
        case "link":
        case "linkReference":
          push(from, to, "link")
          if (block[from] === "[" || block[from] === "<") around(node, span)
          break
        case "image":
        case "imageReference":
        case "definition":
        case "thematicBreak":
          push(from, to, "syntax")
          break
        case "heading": {
          const depth = node.depth ?? 1
          if (depth <= 4) push(from, to, `h${depth}` as StyleKind)
          const inner = innerOf(node)
          if (!inner) push(from, to, "syntax")
          else {
            push(from, inner[0], "syntax")
            push(inner[1], to, "syntax")
          }
          break
        }
        case "blockquote": {
          push(from, to, "blockquote")
          // Each line's `>` marks.
          for (let at = from; at < to;) {
            const end = block.indexOf("\n", at)
            const line = block.slice(at, end === -1 || end > to ? to : end)
            const marks = /^[ \t]*(?:>[ \t]?)+/.exec(line)?.[0].length ?? 0
            push(at, at + marks, "syntax")
            if (end === -1 || end >= to) break
            at = end + 1
          }
          break
        }
        case "code": {
          push(from, to, "pre")
          const raw = block.slice(from, to)
          const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
          if (open) {
            const first = raw.indexOf("\n")
            push(from, first === -1 ? to : from + first, "syntax")
            const last = raw.lastIndexOf("\n")
            if (last !== -1 && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(raw.slice(last + 1)))
              push(from + last + 1, to, "syntax")
          }
          break
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return out
}

/** Blocks' ranges by their text; bounded, so a long session's edits don't pile up. */
export interface StyleCache {
  readonly blocks: Map<string, ReadonlyArray<number>>
}
export const styleCache = (): StyleCache => ({ blocks: new Map() })
const CACHE_BLOCKS = 4096

/** The source offset of fixed offset `at` starting a range: the first character with a source. */
function startSource(runs: ReadonlyArray<SourceRun>, at: number, run: number): number | null {
  for (let i = run; i < runs.length; i++) {
    const r = runs[i]!
    if (r.to <= at) continue
    if (r.source !== null) return r.source + Math.max(0, at - r.from)
  }
  return null
}
/** The source offset just past fixed offset `at - 1` ending a range: past the last character with a source. */
function endSource(runs: ReadonlyArray<SourceRun>, at: number, run: number): number | null {
  for (let i = Math.min(run, runs.length - 1); i >= 0; i--) {
    const r = runs[i]!
    if (r.from >= at) continue
    if (r.source !== null) return r.source + Math.min(at, r.to) - r.from
  }
  return null
}
/** The index of the run holding fixed offset `at` (or the last before it). */
function runAt(runs: ReadonlyArray<SourceRun>, at: number): number {
  let lo = 0
  let hi = runs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (runs[mid]!.from <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The styled ranges of the stored `text` (line ends `\n`, as the editor has them). `cache` keeps
 * each block's ranges by its text between calls.
 */
export function messageStyleRanges(text: string, options: StyleOptions = {}, cache = styleCache()): StyleRanges {
  const html = options.html === true
  const { text: fixed, runs } = fixMarkdownRuns(text)
  const { blocks, starts, rendered } = stBlocks(fixed)
  const triples: Array<[number, number, number]> = []
  const seen = new Set<string>()
  for (const [index, block] of blocks.entries()) {
    const start = starts[index]!
    if (start < 0) continue
    const content = rendered[index]!
    const key = (html ? "h" : "p") + content
    seen.add(key)
    let ranges = cache.blocks.get(key)
    if (!ranges) {
      ranges = blockRanges(content, html)
      cache.blocks.set(key, ranges)
    }
    for (let i = 0; i < ranges.length; i += 3) {
      // Copied reference definitions at the block's end aren't in the text.
      const from = start + ranges[i]!
      const to = start + Math.min(ranges[i + 1]!, block.length)
      if (to <= from) continue
      const source = runs.length ? startSource(runs, from, runAt(runs, from)) : from
      const sourceEnd = runs.length ? endSource(runs, to, runAt(runs, to - 1)) : to
      if (source !== null && sourceEnd !== null && sourceEnd > source) triples.push([source, sourceEnd, ranges[i + 2]!])
    }
  }
  if (cache.blocks.size > CACHE_BLOCKS)
    for (const key of cache.blocks.keys()) if (!seen.has(key)) cache.blocks.delete(key)
  // Outer first: by start, then the longer, then the kind that wraps the other in the message
  // (a quote around the node it covers).
  triples.sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2])
  const out = new Int32Array(triples.length * 3)
  triples.forEach(([from, to, kind], i) => {
    out[3 * i] = from
    out[3 * i + 1] = to
    out[3 * i + 2] = kind
  })
  return out
}

/** The ranges as objects, for tests and readers. */
export const styleList = (ranges: StyleRanges) =>
  Array.from({ length: ranges.length / 3 }, (_, i) => ({
    from: ranges[3 * i]!,
    to: ranges[3 * i + 1]!,
    kind: STYLE_KINDS[ranges[3 * i + 2]!]!
  }))
