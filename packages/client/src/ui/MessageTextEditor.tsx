// The text of a message being edited, styled as the message renders it (messageStyleView.ts):
// the stored text, Markdown marks and all, in a CodeMirror box like every other prose editor, so
// undo, spellcheck, plain-text paste, IME, touch keyboards, screen readers and the browser's own
// menu work as they do there. It takes the same props as `CodeEditor` and drops in for it.
import { lazy, Suspense, useContext, useState, useSyncExternalStore } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import { HtmlSettingsContext } from "./html/messageHtml.ts"
import { effectiveSchema, htmlPartsRevision, subscribeHtmlParts } from "./html/parts.ts"
import { loadedMessageTextEditor, loadMessageTextEditor } from "./messageTextLoader.ts"

const Surface = lazy(loadMessageTextEditor)

export function MessageTextEditor(props: CodeEditorProps) {
  // HTML is HTML in the editor's styling where the message shows it so (StMarkdown.tsx).
  const settings = useContext(HtmlSettingsContext)
  useSyncExternalStore(subscribeHtmlParts, htmlPartsRevision, htmlPartsRevision)
  const html = settings.html && effectiveSchema() !== null
  // Already here as it mounts: drawn in this frame, with no loading line between. Kept for the
  // box's life, so it's never mounted again (its caret and undo with it) once the code arrives.
  const [Loaded] = useState(loadedMessageTextEditor)
  if (Loaded !== null) return <Loaded {...props} html={html} />
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted">
          Loading editor…
        </p>
      }
    >
      <Surface {...props} html={html} />
    </Suspense>
  )
}
