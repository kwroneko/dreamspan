import type { Extension } from "@codemirror/state"
import { lazy, type ReactNode, type Ref, Suspense } from "react"

/** What a text box offers its owner beyond its props. */
interface TextSurfaceHandle {
  /** Focus the text, with the caret at `at` (an offset in the text) when given, else where it was. */
  readonly focus: (at?: number) => void
}

export interface CodeEditorProps {
  highlights?: ReadonlyArray<{ readonly at: number; readonly length: number }> | undefined
  value: string
  /** Text at the revision this draft was typed against. */
  base: string
  /** The last revision, for a field-only revert recorded as an ordinary editor edit. */
  lastRevision?: string | undefined
  /** Explicit field-history restore; false leaves the current text alone. */
  onRevert?: (() => Promise<boolean>) | undefined
  /** Select and reveal a range; a fresh object requests another visit. */
  selection?: { readonly at: number; readonly length: number } | undefined
  onRevealSelection?: ((host: HTMLElement, top: number) => void) | undefined
  /** Briefly mark a range and scroll it into view, leaving focus where it is: text just added. A fresh object marks again. */
  flash?: { readonly at: number; readonly length: number } | undefined
  label: string
  fullHeight?: boolean | undefined
  /** Focus it when it opens, with the caret at the end of the text, in view. */
  autoFocus?: boolean | undefined
  /** With `autoFocus`, the caret's offset in the text instead of its end. */
  caret?: number | undefined
  /** With `caret`, the viewport y its line had where it was chosen (a double-click on the text): the box and the page scroll to keep it there. */
  caretTop?: number | undefined
  /** After `caretTop` scrolled anything: a virtualized list catches up with its offset. */
  onCaretPlaced?: (() => void) | undefined
  /** The snippet editor's own text: its text actions don't offer sending it to a snippet. */
  source?: "snippet" | undefined
  /** False: no text actions under it, for text that isn't prose (a pattern, a template's markers). */
  textActions?: boolean | undefined
  /** The field's own controls, in the strip inside its bottom border after the text actions (`FieldFrame`). */
  tools?: ReactNode
  /** At the strip's start: "edited", the token count. */
  status?: ReactNode
  /** False: no Open large in the strip. Prose that can be edited has it (owner, 2026-11-02). */
  expand?: boolean | undefined
  /**
   * In place of the text it edits (a message's edit): no border, strip, gutter or padding of its
   * own, the font, size, line height and colour of what's around it, a blank line between
   * paragraphs as tall as the gap the rendered text has there (`--message-paragraph-gap`) and a
   * list item's line padded as the rendered item (`--message-list-item-padding`), so its lines
   * fall where the text's did. All its lines are drawn, so its height is exact; it grows with its
   * text, without a height limit; its text actions and tools are the host's to place.
   */
  bare?: boolean | undefined
  /** The change markers in the gutter only once the text differs from `base`: a plain text box until then. */
  quietMarkers?: boolean | undefined
  rows?: number | undefined
  /** A CSS height the box is at least, overriding `rows`: a field opened large. */
  minHeight?: string | undefined
  mono?: boolean | undefined
  /** A syntax mode (`codeLanguages.ts`, by `languageOf`), loaded when first needed. */
  language?: string | null | undefined
  readOnly?: boolean | undefined
  onChange: (value: string) => void
  onSelectionRangeChange?: ((range: { readonly at: number; readonly length: number }) => void) | undefined
  onSelectionChange?: ((text: string) => void) | undefined
  onBlur?: (() => void) | undefined
  /** More CodeMirror extensions for this box (the message editor's styling); a new value reconfigures them. */
  extensions?: Extension | undefined
  /** A class on the element holding the text, for what the text inherits there (its font, line height). */
  surfaceClass?: string | undefined
  ref?: Ref<TextSurfaceHandle> | undefined
}

const Editor = lazy(() => import("./CodeEditorView.tsx"))

/** The code editor is fetched only when a surface actually uses it. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted">
          Loading editor…
        </p>
      }
    >
      <Editor {...props} />
    </Suspense>
  )
}
