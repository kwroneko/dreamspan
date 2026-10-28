/** Text surfaces opt in here; commands can transfer text without knowing the editor. */
export interface TextSelection {
  readonly editable?: boolean
  readonly text: string
  readonly insert: (text: string) => void
}
const editors = new WeakMap<EventTarget, () => TextSelection>()
export const registerTextTarget = (host: HTMLElement, read: () => TextSelection) => {
  editors.set(host, read)
  return () => editors.delete(host)
}
export const textSelection = (event: Event): TextSelection | null => {
  for (const node of event.composedPath()) {
    const editor = editors.get(node)
    if (editor) return editor()
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      if (
        node.disabled ||
        node.selectionStart === null ||
        (node instanceof HTMLInputElement && (node.type === "password" || node.dataset.formType === "other"))
      )
        return null
      const from = node.selectionStart,
        to = node.selectionEnd ?? from
      return {
        editable: !node.readOnly,
        text: node.value.slice(from, to),
        insert: (text) => {
          if (!node.isConnected || node.disabled || node.readOnly) return
          const next = node.value.slice(0, from) + text + node.value.slice(to)
          const prototype =
            node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, next)
          node.dispatchEvent(new Event("input", { bubbles: true }))
          node.focus()
          node.setSelectionRange(from + text.length, from + text.length)
        }
      }
    }
  }
  return null
}
