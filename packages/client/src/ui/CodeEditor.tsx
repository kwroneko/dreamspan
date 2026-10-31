import { lazy, Suspense } from "react"

export interface CodeEditorProps {
  value: string
  /** Text at the revision this draft was typed against. */
  base: string
  /** Select and reveal a range; a fresh object requests another visit. */
  selection?: { readonly at: number; readonly length: number } | undefined
  onRevealSelection?: ((host: HTMLElement, top: number) => void) | undefined
  label: string
  fullHeight?: boolean | undefined
  /** Focus it when it opens, with the caret at the end of the text, in view. */
  autoFocus?: boolean | undefined
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
