import { useMemo } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import CodeEditorView from "./CodeEditorView.tsx"
import { messageStyling } from "./messageStyleView.ts"

/** The message editor's box (MessageTextEditor.tsx), loaded with the editor. */
export default function MessageTextSurface({ html, ...props }: CodeEditorProps & { readonly html: boolean }) {
  // `plain` drops only the styling (the composer's guidance): the box, its text, caret and scroll stay.
  // A form field holding message text (a card's greeting, `messageField`) keeps the field's metrics.
  const place = props.messageField
  const styling = useMemo(
    () =>
      props.plain
        ? []
        : messageStyling(html, place === undefined ? {} : { field: true, examples: place === "examples" }),
    [html, props.plain, place]
  )
  const extensions = useMemo(() => [styling, props.extensions ?? []], [styling, props.extensions])
  // `message-edit-text` gives the text the message's own font, line height and color (styles.css);
  // a host with its own box (the composer) names its class instead.
  return <CodeEditorView {...props} extensions={extensions} surfaceClass={props.surfaceClass ?? "message-edit-text"} />
}
