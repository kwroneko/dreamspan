/** Copies the supplied source text, including on HTTP where Clipboard API is absent. */
export const copyText = async (text: string): Promise<void> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // A browser may expose the API but refuse it; try the user-initiated copy below.
  }

  const active = document.activeElement
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : []
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  textarea.setAttribute("aria-hidden", "true")
  Object.assign(textarea.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" })
  // Keep the temporary field inside an open dialog's focus trap.
  const host = active instanceof Element ? active.closest('[role="dialog"], [role="alertdialog"]') : null
  ;(host ?? document.body).append(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.")
  } finally {
    textarea.remove()
    if (active instanceof HTMLElement) active.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
