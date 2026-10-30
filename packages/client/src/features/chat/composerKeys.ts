import type { DisplayPrefs } from "@rp/shared/chatApi.ts"
import type { KeyboardEvent } from "react"

type EnterSends = DisplayPrefs["enterSends"]
const plainEnterSends = (mode: EnterSends) =>
  mode === "always" ||
  (mode === "automatic" && !(typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches))
export const composerSubmitHint = (mode: EnterSends) =>
  plainEnterSends(mode) ? "Enter; Shift+Enter for a new line" : "Ctrl/Cmd+Enter; Enter for a new line"

/** Account preference applies to saved and pending chats. Never send Alt or IME Enter. */
export const composerKeyDown =
  (send: () => unknown, mode: EnterSends = "automatic") =>
  (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.altKey || event.nativeEvent.isComposing) return
    if (event.ctrlKey || event.metaKey || (!event.shiftKey && plainEnterSends(mode))) {
      event.preventDefault()
      void send()
    }
  }
