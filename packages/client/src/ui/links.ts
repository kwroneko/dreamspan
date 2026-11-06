// Openers are links (owner, 2026-11-05: so they can be opened in new browser tabs). A plain
// click runs the opener's own logic; a middle click, or one with a modifier, is the browser's.
const plainClick = (event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented?: boolean
}) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented

/** A Link's `onClick` that runs `open` instead, for a plain click only. */
export const openOnPlainClick =
  (open: () => void) =>
  (event: {
    button: number
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    defaultPrevented: boolean
    preventDefault: () => void
  }) => {
    if (!plainClick(event)) return
    event.preventDefault()
    open()
  }
