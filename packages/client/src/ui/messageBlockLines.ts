// The message editor's quotes and list items take the room the message gives them (styles.css
// `.markdown blockquote`, `.markdown ul`), so their lines wrap where the rendered lines do and an
// edit opened in place of the text moves nothing (features/chat/InPlaceEdit.tsx). A quote's or a
// list item's line is inset by the rendered block's inset, its marks (`> `, `- `, `1. `) hanging
// in that inset where the rendered bar or bullet is; a line continuing an item is inset with it.
// A quote draws its bar there too. Lines in a fenced code block are left as they are.
import { type Extension, RangeSetBuilder, type Text } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { exampleMessages } from "./messageStyles.ts"

/** The rendered insets (styles.css): a quote's bar and padding, a list's padding. */
const QUOTE = "(3px + 0.9em)"
const LIST = "1.5em"

const QUOTE_MARK = /^ {0,3}> ?/
const LIST_MARK = /^(\s*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

type Part = typeof QUOTE | typeof LIST

/** The CSS length of a run of insets. */
const length = (parts: ReadonlyArray<Part>) => (parts.length === 0 ? "0px" : `calc(${parts.join(" + ")})`)

/** A quote bar for each quote among `parts`, where its inset starts. */
function bars(parts: ReadonlyArray<Part>): string | null {
  const out: string[] = []
  parts.forEach((part, i) => {
    if (part === QUOTE)
      out.push(`linear-gradient(var(--border), var(--border)) no-repeat ${length(parts.slice(0, i))} 0 / 3px 100%`)
  })
  return out.length > 0 ? out.join(", ") : null
}

const lineDecorations = new Map<string, Decoration>()
const markDecorations = new Map<string, Decoration>()

function lineDecoration(parts: ReadonlyArray<Part>, hanging: boolean): Decoration {
  const key = `${parts.join("|")}${hanging ? "h" : "c"}`
  let decoration = lineDecorations.get(key)
  if (!decoration) {
    const bar = bars(parts)
    decoration = Decoration.line({
      class: hanging ? "rp-block rp-block-hanging" : "rp-block",
      attributes: { style: `--rp-inset: ${length(parts)};${bar ? ` background: ${bar};` : ""}` }
    })
    lineDecorations.set(key, decoration)
  }
  return decoration
}

function markDecoration(parts: ReadonlyArray<Part>): Decoration {
  const key = parts.join("|")
  let decoration = markDecorations.get(key)
  if (!decoration) {
    decoration = Decoration.mark({ class: "rp-block-marks", attributes: { style: `min-width: ${length(parts)}` } })
    markDecorations.set(key, decoration)
  }
  return decoration
}

/** The insets of one message, in the document's coordinates. */
function decorateMessage(doc: Text, builder: RangeSetBuilder<Decoration>, from: number, to: number) {
  const last = doc.lineAt(to).number
  let fence: string | null = null
  // The open list items, outermost first: where each one's text starts, and the quotes around it.
  let items: Array<{ content: number; parts: Part[] }> = []
  let previousBlank = true
  for (let number = doc.lineAt(from).number; number <= last; number++) {
    const line = doc.line(number)
    const start = Math.max(from, line.from)
    const text = line.text.slice(start - line.from, to - line.from)
    const fenced = FENCE.exec(text)
    const marks = fenced?.[1]
    const info = fenced?.[2] ?? ""
    if (fence !== null || (marks && (marks[0] === "~" || !info.includes("`")))) {
      if (fence === null) fence = marks!
      else if (marks?.startsWith(fence) && /^[ \t]*$/.test(info)) fence = null
      items = []
      previousBlank = false
      continue
    }
    if (text.trim() === "") {
      previousBlank = true
      continue
    }
    const parts: Part[] = []
    let at = 0
    for (let quote = QUOTE_MARK.exec(text); quote; quote = QUOTE_MARK.exec(text.slice(at))) {
      parts.push(QUOTE)
      at += quote[0].length
    }
    const item = LIST_MARK.exec(text.slice(at))
    if (item) {
      const indent = item[1]!.length
      while (items.length > 0 && indent < items.at(-1)!.content) items.pop()
      items.push({ content: indent + item[0].length, parts: [...parts] })
      const inset = [...parts, ...items.map(() => LIST as Part)]
      builder.add(line.from, line.from, lineDecoration(inset, true))
      builder.add(start, start + at + item[0].length, markDecoration(inset))
    } else {
      // A line under an item continues it when indented to its text, or right after it.
      const indent = /^\s*/.exec(text.slice(at))![0].length
      while (items.length > 0 && indent < items.at(-1)!.content && previousBlank) items.pop()
      if (items.length > 0)
        builder.add(line.from, line.from, lineDecoration([...parts, ...items.map(() => LIST as Part)], false))
      else if (parts.length > 0) {
        builder.add(line.from, line.from, lineDecoration(parts, true))
        builder.add(start, start + at, markDecoration(parts))
      }
    }
    previousBlank = false
  }
}

/** The insets of every line, with independent block state for each example message. */
export function blockLines(doc: Text, examples = false): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (examples) {
    for (const [from, to] of exampleMessages(doc.toString())) decorateMessage(doc, builder, from, to)
  } else decorateMessage(doc, builder, 0, doc.length)
  return builder.finish()
}

const theme = EditorView.theme({
  "&.rp-message-text.rp-bare .cm-line.rp-block": { paddingLeft: "var(--rp-inset)" },
  "&.rp-message-text:not(.rp-bare) .cm-line.rp-block": { paddingLeft: "calc(10px + var(--rp-inset))" },
  "&.rp-message-text .cm-line.rp-block-hanging": { textIndent: "calc(-1 * var(--rp-inset))" },
  "&.rp-message-text .rp-block-marks": { display: "inline-block", textIndent: "0", whiteSpace: "pre" }
})

/** Quotes and list items inset as the message renders them. */
export const messageBlockLines = (examples: boolean): Extension => [
  theme,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = blockLines(view.state.doc, examples)
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = blockLines(update.state.doc, examples)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
]
