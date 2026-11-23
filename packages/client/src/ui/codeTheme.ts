import { EditorState, RangeSetBuilder } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

// A shadow root lets style-mod use a constructed stylesheet under our strict CSP.
// All colors and fonts inherit the app's semantic tokens, including live theme changes.
export const proseTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontSize: "16px",
    borderRadius: "6px",
    // Set while a height dragged with the box's grip holds (CodeEditorView.tsx).
    height: "var(--editor-height, auto)"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font, var(--font-sans))",
    lineHeight: "1.6",
    overflow: "auto",
    maxHeight: "var(--editor-max-height, min(60vh, 32rem))"
  },
  ".cm-content": {
    padding: "8px 0",
    minHeight: "var(--editor-min-height, 6rem)",
    caretColor: "var(--text)",
    overflowWrap: "anywhere"
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--accent) 22%, transparent)"
  },
  ".cm-content ::selection": { backgroundColor: "color-mix(in oklch, var(--accent) 22%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-raised)",
    color: "var(--text-muted)",
    borderRight: "1px solid var(--border)"
  },
  ".rp-line-marker": {
    display: "block",
    width: "14px",
    textAlign: "center",
    fontWeight: "bold",
    fontFamily: "var(--font-mono)"
  },
  ".rp-line-added": {
    color: "var(--success)",
    backgroundColor: "color-mix(in oklch, var(--success) 15%, transparent)"
  },
  ".rp-line-modified": {
    color: "var(--accent)",
    backgroundColor: "color-mix(in oklch, var(--accent) 15%, transparent)"
  },
  ".rp-line-deleted": {
    color: "var(--danger)",
    backgroundColor: "color-mix(in oklch, var(--danger) 15%, transparent)"
  },
  ".rp-macro-comment": { color: "var(--macro-comment)" },
  ".rp-macro-value": { color: "var(--macro-value)" },
  ".rp-macro-directive": { color: "var(--macro-directive)" },
  ".rp-flash": {
    backgroundColor: "color-mix(in oklch, var(--accent) 30%, transparent)",
    borderRadius: "2px"
  },
  ".rp-line-unchanged": { color: "var(--text-muted)" },
  // Quiet markers keep the gutter's width, so the text never shifts when the first change shows it.
  "&.rp-unchanged .cm-gutters": { visibility: "hidden" },
  "&.rp-quiet .rp-line-unchanged": { visibility: "hidden" },
  ".cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in oklch, var(--success) 10%, transparent)" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--danger) 10%, transparent)"
  },
  ".rp-search-match": { backgroundColor: "color-mix(in oklch, var(--warning) 30%, transparent)" },
  ".cm-insertedLine, .cm-deletedLine": { background: "none", textDecoration: "none" },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in oklch, var(--success) 22%, transparent)",
    textDecoration: "none"
  },
  "&.cm-merge-a .cm-changedText, &.cm-merge-b .cm-deletedText": {
    background: "color-mix(in oklch, var(--danger) 22%, transparent)",
    textDecoration: "line-through"
  },
  "&.cm-merge-a .cm-changedLineGutter": { backgroundColor: "var(--danger)" },
  "&.cm-merge-b .cm-changedLineGutter": { backgroundColor: "var(--success)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--danger)" },
  ".cm-insertedLineGutter": { backgroundColor: "var(--success)" },
  ".cm-deletedChunk": { padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-deletedChunk .cm-deletedText": { backgroundColor: "color-mix(in oklch, var(--danger) 22%, transparent)" },
  "@media (min-width: 640px)": { "&": { fontSize: "14px" } },
  // In place of the text it edits (`bare`): the metrics of what's around it, nothing of its own.
  "&.rp-bare": { backgroundColor: "transparent", color: "inherit", fontSize: "inherit", borderRadius: "0" },
  "&.rp-bare .cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", maxHeight: "none", overflow: "visible" },
  "&.rp-bare .cm-content": { padding: "0", minHeight: "0" },
  "&.rp-bare .cm-line": { padding: "0" },
  // A blank line between paragraphs is as tall as the rendered text's gap there (styles.css).
  "&.rp-bare .cm-line.rp-paragraph-gap": { lineHeight: "var(--message-paragraph-gap, 0.75em)" },
  // A list item's line has the rendered item's padding (styles.css).
  "&.rp-bare .cm-line.rp-list-item": { paddingBlock: "var(--message-list-item-padding, 0.25rem)" },
  // Message text styled as the message (messageStyleView.ts) has no padding of its own; in a
  // framed box (a version the user writes, the edit's thinking) the frame keeps the prose padding.
  "&.rp-message-text:not(.rp-bare) .cm-content": { padding: "8px 0" },
  "&.rp-message-text:not(.rp-bare) .cm-line": { padding: "0 10px" }
})

const paragraphGap = Decoration.line({ class: "rp-paragraph-gap" })
const listItem = Decoration.line({ class: "rp-list-item" })
/** A markdown list item's line: a bullet or a number, then a space. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/

/**
 * The lines whose rendered counterparts have room of their own: a blank line between
 * paragraphs (the paragraph gap) and a list item (its padding), marked so they take the same.
 */
function lineMetrics(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  for (const { from, to } of view.visibleRanges) {
    for (let at = from; at <= to;) {
      const line = doc.lineAt(at)
      if (line.length === 0 && line.number > 1 && line.number < doc.lines)
        builder.add(line.from, line.from, paragraphGap)
      else if (LIST_ITEM.test(line.text)) builder.add(line.from, line.from, listItem)
      at = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * A bare editor draws all its lines, so it's exactly as tall as its text from the start and
 * never changes height as lines come into view. Otherwise CodeMirror draws only the lines near
 * the screen and estimates the others' heights, wrongly for wrapped prose and paragraph gaps: a
 * long message's edit would put the caret's line off its place and grow as it scrolls. What
 * CodeMirror does while the page prints (its view state's `printing`) is exactly that, so it's
 * held on here, again after a print turns it off.
 */
const drawAllLines = ViewPlugin.define((view) => {
  const state = (view as unknown as { viewState: { printing: boolean } }).viewState
  const hold = () => {
    if (state.printing) return
    state.printing = true
    view.requestMeasure()
  }
  hold()
  return { update: hold }
})

/** What a `bare` editor adds: its class, all its lines drawn, and its lines' metrics. */
export const bareText = [
  EditorView.editorAttributes.of({ class: "rp-bare" }),
  drawAllLines,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = lineMetrics(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = lineMetrics(update.view)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
]

export const readOnlyProse = [
  proseTheme,
  EditorView.lineWrapping,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false)
]
