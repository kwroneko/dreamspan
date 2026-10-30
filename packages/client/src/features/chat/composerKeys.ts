import type { KeyboardEvent } from "react"

/** Enter sends on a keyboard; touch keyboards keep Enter for a newline. Never submit an IME composition. */
export const composerKeyDown = (send: () => unknown) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key !== "Enter" || event.altKey || event.nativeEvent.isComposing) return
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches
  if (event.ctrlKey || event.metaKey || (!event.shiftKey && !coarse)) {
    event.preventDefault()
    void send()
  }
}
