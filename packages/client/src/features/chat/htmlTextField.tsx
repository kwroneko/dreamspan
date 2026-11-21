// A text field of a message's HTML (a card's form, say), as the chat renders it: what's typed
// into it is kept (editor/durable.tsx) under the version and the field's place in the HTML, so a
// reload, or the message scrolling away, brings it back. The HTML keeps its own text as written.
import type { HtmlTextFieldProps } from "../../ui/html/messageHtml.ts"
import { useDurableText } from "../editor/durable.tsx"

export function HtmlTextField({ fieldKey, tag, props, initial }: HtmlTextFieldProps) {
  const durable = useDurableText(`message-html:${fieldKey}`, "Form field", initial)
  const kept = {
    ...props,
    value: durable.text,
    readOnly: props.readOnly === true || !durable.ready,
    onChange: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      durable.setText(event.currentTarget.value)
  }
  return tag === "textarea" ? <textarea {...kept} /> : <input {...kept} />
}
