import { lazy, type ReactNode, Suspense } from "react"

export interface CodeEditorProps {
  value: string
  /** Text at the revision this draft was typed against. */
  base: string
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
  /** The change markers in the gutter only once the text differs from `base`: a plain text box until then. */
  quietMarkers?: boolean | undefined
  rows?: number | undefined
  /** A CSS height the box is at least, overriding `rows`: a field opened large. */
  minHeight?: string | undefined
  mono?: boolean | undefined
  readOnly?: boolean | undefined
  onChange: (value: string) => void
  onSelectionChange?: ((text: string) => void) | undefined
  onBlur?: (() => void) | undefined
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
