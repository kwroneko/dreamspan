// The chat page's code, loaded with the first chat opened (it carries the Markdown renderer,
// most of the bundle). A pending chat loads it ahead, so the chat its first send saves opens
// at once: the route's skeleton never shows between them (owner, 2026-11-02: nothing flashes).
import type { ComponentType } from "react"
import { loadMessageTextEditor } from "../../ui/messageTextLoader.ts"

let loaded: ComponentType | null = null
let pending: Promise<{ default: ComponentType }> | null = null

export const loadChatPage = () =>
  // The composer's text box comes with it (ui/MessageTextEditor.tsx): fetched side by side, so
  // the page's first frame already has the box, never its loading line.
  (pending ??= Promise.all([import("./ChatPage.tsx"), loadMessageTextEditor()]).then(
    ([module]) => {
      loaded = module.ChatPage
      return { default: module.ChatPage }
    },
    (error: unknown) => {
      // Asked again on the next try.
      pending = null
      throw error
    }
  ))

/** The page's component once its code is here; null before. */
export const loadedChatPage = () => loaded

export const preloadChatPage = () => void loadChatPage().catch(() => undefined)
