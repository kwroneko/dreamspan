import type { DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
import type { KeyboardEvent } from "react"

type EnterSends = DisplayPrefs["enterSends"]
const plainEnterSends = (mode: EnterSends) =>
  mode === "always" ||
  (mode === "automatic" && !(typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches))
export const composerSubmitHint = (mode: EnterSends) =>
  plainEnterSends(mode) ? "Enter; Shift+Enter for a new line" : "Ctrl/Cmd+Enter; Enter for a new line"

/**
 * Account preference applies to saved and pending chats. Never send Alt or IME Enter. Takes a
 * textarea's React event or the chat composer's own (a DOM event from its editor, ui/CodeEditor.tsx),
 * and says whether it sent.
 */
export const composerKeyDown =
  (send: () => unknown, mode: EnterSends = "automatic") =>
  (event: KeyboardEvent<HTMLTextAreaElement> | globalThis.KeyboardEvent): boolean => {
    const composing = "nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing
    if (event.key !== "Enter" || event.altKey || composing || event.keyCode === 229) return false
    if (event.ctrlKey || event.metaKey || (!event.shiftKey && plainEnterSends(mode))) {
      event.preventDefault()
      void send()
      return true
    }
    return false
  }
