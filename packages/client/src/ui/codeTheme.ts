import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

// A shadow root lets style-mod use a constructed stylesheet under our strict CSP.
// All colors and fonts inherit the app's semantic tokens, including live theme changes.
export const proseTheme = EditorView.theme({
  "&": { backgroundColor: "var(--surface)", color: "var(--text)", fontSize: "16px", borderRadius: "6px" },
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
  ".rp-line-unchanged": { color: "var(--text-muted)" },
  ".cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in oklch, var(--success) 10%, transparent)" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--danger) 10%, transparent)"
  },
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
  "@media (min-width: 640px)": { "&": { fontSize: "14px" } }
})

export const readOnlyProse = [
  proseTheme,
  EditorView.lineWrapping,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false)
]
