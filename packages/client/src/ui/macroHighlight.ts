import { StateField } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { highlightMacros, type MacroToken } from "@rp/shared/macros/highlight.ts"
import { parse, type Node } from "@rp/shared/macros/parse.ts"
import { macroRegistry } from "../macros.ts"

interface Parsed {
  readonly nodes: ReadonlyArray<Node>
  readonly tokens: ReadonlyArray<MacroToken>
  readonly safeTo: number
}

const read = (text: string, prefix: ReadonlyArray<Node> = [], from = 0): Parsed => {
  const nodes = [...prefix, ...parse(text, undefined, from)]
  let safeTo = 0
  // A malformed opener in a gap can absorb a later edit. Never reuse a prefix beyond it.
  for (const node of nodes) {
    const open = text.indexOf("{{", safeTo)
    if (open >= 0 && open < node.start && /[^\{]/.test(text.slice(open, node.start))) break
    safeTo = node.end
  }
  return { nodes, tokens: highlightMacros(text, macroRegistry, nodes), safeTo }
}

export const macroTokens = StateField.define<Parsed>({
  create: (state) => read(state.doc.toString()),
  update(previous, tr) {
    if (!tr.docChanged) return previous
    let first = tr.startState.doc.length
    tr.changes.iterChangedRanges((from) => {
      first = Math.min(first, from)
    })
    // Keep completed top-level nodes before the edit, including a two-character brace margin.
    const prefix = previous.nodes.filter((node) => node.end <= Math.min(previous.safeTo, first - 2))
    return read(tr.newDoc.toString(), prefix, prefix.at(-1)?.end ?? 0)
  }
})

const marks = {
  value: Decoration.mark({ class: "rp-macro-value" }),
  directive: Decoration.mark({ class: "rp-macro-directive" }),
  comment: Decoration.mark({ class: "rp-macro-comment" })
}

/** Only visible ranges get DOM marks. Scrolling reuses the parsed document. */
export const macroHighlight = [
  macroTokens,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.visible(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = this.visible(update.view)
      }
      visible(view: EditorView) {
        const ranges = []
        for (const token of view.state.field(macroTokens).tokens) {
          for (const visible of view.visibleRanges) {
            const from = Math.max(token.from, visible.from),
              to = Math.min(token.to, visible.to)
            if (from < to) ranges.push(marks[token.kind].range(from, to))
          }
        }
        return Decoration.set(ranges, true)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
]
