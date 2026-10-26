import { lazy, Suspense } from "react"

export interface CodeEditorProps {
  value: string
  /** Text at the revision this draft was typed against. */
  base: string
  label: string
  rows?: number | undefined
  mono?: boolean | undefined
  readOnly?: boolean | undefined
  onChange: (value: string) => void
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
