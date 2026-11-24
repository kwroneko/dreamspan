import { useSearchHighlights } from "./searchHighlights.ts"
import { type FieldPath, getAt } from "@dreamspan/shared/editing.ts"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { CodeEditor, type CodeEditorProps } from "../../ui/CodeEditor.tsx"
import { MessageTextEditor } from "../../ui/MessageTextEditor.tsx"
import { flashItem } from "../../ui/reveal.ts"
import { scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useComparisonRevision, useEditorKind, useRevisionDoc } from "./store.ts"
import { useFieldTabHref } from "./useFieldTabHref.ts"
import { useEditorReadOnly } from "./readOnly.ts"

/**
 * A card field holding message text, shown styled as the message renders (owner, 2026-11-24:
 * "the greetings, and the example dialogue fields"): the first message and each alternate or
 * group greeting are messages, the example dialogue is messages between `<START>` lines and
 * speaker prefixes. Everything else (description, personality, scenario, the prompts, the
 * creator's notes) is prompt or reference text and stays plain.
 */
function cardMessageField(kind: string | undefined, path: FieldPath): CodeEditorProps["messageField"] {
  if (kind !== "card") return undefined
  const [field, index] = path
  if (path.length === 1 && field === "first_mes") return "message"
  if (path.length === 1 && field === "mes_example") return "examples"
  if (
    path.length === 2 &&
    (field === "alternate_greetings" || field === "group_only_greetings") &&
    typeof index === "number"
  )
    return "message"
  return undefined
}

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
  resizable,
  mono,
  readOnly,
  source,
  tools,
  status,
  expand,
  fill,
  autoFocus,
  flash,
  onSelectionRangeChange,
  onChange,
  onBlur
}: {
  store: EditorStore
  field: string
  path: FieldPath
  value: string
  label: string
  fullHeight?: boolean | undefined
  /** False: no height grip, for a box that fills a dialog. */
  resizable?: boolean | undefined
  rows?: number | undefined
  minHeight?: string | undefined
  mono?: boolean | undefined
  readOnly?: boolean | undefined
  /** A snippet's own text: it offers no sending to a snippet. */
  source?: "snippet" | undefined
  /** The field's own controls and status, in the strip inside its box (`ui/FieldFrame`). */
  tools?: ReactNode
  status?: ReactNode
  /** False: no button opening it in its own tab (the field's tab itself). */
  expand?: boolean | undefined
  /** Fills its container's height, its text scrolling inside (the field's tab). */
  fill?: boolean | undefined
  /** Focused when it opens, the caret at the end. */
  autoFocus?: boolean | undefined
  /** Text just added, marked briefly and scrolled into view. */
  flash?: { readonly at: number; readonly length: number } | undefined
  onSelectionRangeChange?: ((range: { readonly at: number; readonly length: number }) => void) | undefined
  onChange: (value: string) => void
  onBlur?: (() => void) | undefined
}) {
  const highlights = useSearchHighlights(store, path)
  // A card shown for reading (readOnly.ts): nothing can be typed, but each field still opens in a tab.
  const reading = useEditorReadOnly()
  const locked = readOnly || reading
  const tabLink = useFieldTabHref(store, path, label, field)
  const expandTab = expand !== false && !mono && (!readOnly || reading) ? tabLink : undefined
  const saved = getAt(useRevisionDoc(store) ?? {}, path)
  const searchMatch = useSearchMatch(path)
  const revision = useComparisonRevision(store, field)
  const [comparison, setComparison] = useState<{ revision: typeof revision; value: string } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const key = JSON.stringify(path)
  const kind = useEditorKind(store)
  const messageField = mono ? undefined : cardMessageField(kind, path)
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
  const props: CodeEditorProps = {
    value,
    autoFocus,
    selection: searchMatch,
    highlights,
    flash,
    onRevealSelection: (host, top) => {
      scrollToSearchField(host, top)
      // The lazy editor's frame exists once its selection can be revealed.
      if (searchMatch?.landed) {
        const frame = host.closest<HTMLElement>("[data-field-frame]")
        if (frame) flashItem(frame)
      }
    },
    base: comparison?.revision === revision ? comparison.value : value,
    label,
    rows,
    minHeight,
    fullHeight,
    resizable,
    mono,
    // Prose has text actions; a pattern or a template's markers (mono) doesn't.
    textActions: !mono,
    readOnly: locked,
    source,
    tools,
    ...(locked ? {} : { lastRevision: typeof saved === "string" ? saved : "" }),
    onRevert: async () => {
      const result = await store.revertField(field, path, typeof saved === "string" ? saved : "")
      setError(result.ok ? null : result.error)
      return result.ok && getAt(store.working().doc, path) === (typeof saved === "string" ? saved : "")
    },
    status,
    expandTab,
    fill,
    onSelectionRangeChange,
    onChange,
    onBlur
  }
  return (
    <>
      {messageField === undefined ? (
        <CodeEditor {...props} />
      ) : (
        // The same box and styling as a message's edit and the composer (ui/MessageTextEditor.tsx).
        <MessageTextEditor {...props} messageField={messageField} />
      )}
      <ErrorAlert error={error} />
    </>
  )
}
