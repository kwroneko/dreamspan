import { MergeView, unifiedMergeView } from "@codemirror/merge"
import { EditorView } from "@codemirror/view"
import { useEffect, useRef, useState } from "react"
import { readOnlyProse } from "./codeTheme.ts"

const mergeLayout = new CSSStyleSheet()
mergeLayout.replaceSync(
  ".cm-mergeView {max-height:min(60vh,32rem);overflow:auto} .cm-mergeView .cm-scroller {max-height:none}"
)

export default function RevisionDiffView({
  before,
  after,
  sideBySide = false,
  beforeLabel = "Before",
  afterLabel = "After"
}: {
  before: string
  after: string
  sideBySide?: boolean
  beforeLabel?: string
  afterLabel?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 639px)").matches)
  useEffect(() => {
    const media = matchMedia("(max-width: 639px)")
    const change = () => setNarrow(media.matches)
    media.addEventListener("change", change)
    return () => media.removeEventListener("change", change)
  }, [])
  useEffect(() => {
    const element = host.current!
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" })
    if (!root.adoptedStyleSheets.includes(mergeLayout))
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, mergeLayout]
    const attributes = (label: string) =>
      EditorView.contentAttributes.of({
        role: "textbox",
        "aria-readonly": "true",
        "aria-label": label,
        "aria-multiline": "true"
      })
    const unified = narrow && !sideBySide
    const view = unified
      ? new EditorView({
          root,
          parent: root,
          doc: after,
          extensions: [
            ...readOnlyProse,
            attributes("Changes"),
            unifiedMergeView({
              original: before,
              mergeControls: false,
              syntaxHighlightDeletions: false,
              diffConfig: { scanLimit: 2000, timeout: 50 }
            })
          ]
        })
      : new MergeView({
          root,
          parent: root,
          a: { doc: before, extensions: [...readOnlyProse, attributes(beforeLabel)] },
          b: { doc: after, extensions: [...readOnlyProse, attributes(afterLabel)] },
          diffConfig: { scanLimit: 2000, timeout: 50 }
        })
    return () => view.destroy()
  }, [before, after, narrow, sideBySide, beforeLabel, afterLabel])
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border bg-surface">
      <div
        className="grid grid-cols-2 border-b border-border bg-surface-raised px-3 py-1 text-xs text-muted"
        aria-hidden="true"
      >
        {narrow && !sideBySide ? (
          <span className="col-span-2">Removed (−) and added (+)</span>
        ) : (
          <>
            <span>{beforeLabel}</span>
            <span>{afterLabel}</span>
          </>
        )}
      </div>
      <div ref={host} />
    </div>
  )
}
