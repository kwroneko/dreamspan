import { useMemo } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import CodeEditorView from "./CodeEditorView.tsx"
import { messageStyling } from "./messageStyleView.ts"

/** The message editor's box (MessageTextEditor.tsx), loaded with the editor. */
export default function MessageTextSurface({ html, ...props }: CodeEditorProps & { readonly html: boolean }) {
  const styling = useMemo(() => messageStyling(html), [html])
  // `message-edit-text` gives the text the message's own font, line height and color (styles.css).
  return <CodeEditorView {...props} extensions={styling} surfaceClass="message-edit-text" />
}
