import { type FieldPath, getAt } from "@rp/shared/editing.ts"
import { useEffect, useState } from "react"
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
  fullHeight,
  mono,
  readOnly,
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
  mono?: boolean | undefined
  readOnly?: boolean | undefined
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
        selection={searchMatch}
        onRevealSelection={scrollToSearchField}
        base={comparison?.revision === revision ? comparison.value : value}
        label={label}
        rows={rows}
        fullHeight={fullHeight}
        mono={mono}
        readOnly={readOnly}
        onChange={onChange}
        onBlur={onBlur}
      />
      <ErrorAlert error={error} />
    </>
  )
}
