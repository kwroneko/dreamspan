import { type FieldPath, getAt } from "@rp/shared/editing.ts"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useComparisonRevision } from "./store.ts"

/** Comparison reads never alter a draft or the identity its next save will name. */
export function CardTextEditor({
  store,
  field,
  path,
  value,
  label,
  rows,
  minHeight,
  fullHeight,
  mono,
  readOnly,
  source,
  tools,
  status,
  expand,
  autoFocus,
  flash,
  onChange,
  onBlur
}: {
  store: EditorStore
  field: string
  path: FieldPath
  value: string
  label: string
  fullHeight?: boolean | undefined
  rows?: number | undefined
  minHeight?: string | undefined
  mono?: boolean | undefined
  readOnly?: boolean | undefined
  /** A snippet's own text: it offers no sending to a snippet. */
  source?: "snippet" | undefined
  /** The field's own controls and status, in the strip inside its box (`ui/FieldFrame`). */
  tools?: ReactNode
  status?: ReactNode
  /** False: no Open large (the large box itself). */
  expand?: boolean | undefined
  /** Focused when it opens, the caret at the end. */
  autoFocus?: boolean | undefined
  /** Text just added, marked briefly and scrolled into view. */
  flash?: { readonly at: number; readonly length: number } | undefined
  onChange: (value: string) => void
  onBlur?: (() => void) | undefined
}) {
  const searchMatch = useSearchMatch(path)
  const revision = useComparisonRevision(store, field)
  const [comparison, setComparison] = useState<{ revision: typeof revision; value: string } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const key = JSON.stringify(path)
  useEffect(() => {
    let live = true
    if (revision !== null)
      void store.revisionDoc(revision).then(
        (doc) => {
          const base = getAt(doc, JSON.parse(key) as FieldPath)
          if (live) {
            setComparison({ revision, value: typeof base === "string" ? base : "" })
            setError(null)
          }
        },
        (error: AppError) => {
          if (live) setError(error)
        }
      )
    return () => {
      live = false
    }
  }, [store, revision, key])
  return (
    <>
      <CodeEditor
        value={value}
        autoFocus={autoFocus}
        selection={searchMatch}
        flash={flash}
        onRevealSelection={scrollToSearchField}
        base={comparison?.revision === revision ? comparison.value : value}
        label={label}
        rows={rows}
        minHeight={minHeight}
        fullHeight={fullHeight}
        mono={mono}
        // Prose has text actions; a pattern or a template's markers (mono) doesn't.
        textActions={!mono}
        readOnly={readOnly}
        source={source}
        tools={tools}
        status={status}
        expand={expand}
        onChange={onChange}
        onBlur={onBlur}
      />
      <ErrorAlert error={error} />
    </>
  )
}
