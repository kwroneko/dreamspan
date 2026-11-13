// Which chat a URL choice belongs to when two are on one page: a story and the workshop beside it
// (spec/WORKSHOP.md §4). The page's own chat uses the plain keys (`messageDialog`, `fork`); a chat
// shown inside another's panel uses them under its scope (`side.messageDialog`, `side.fork`), so a
// dialog opened in one never opens in the other, and a reload shows both as they were.
import { createContext, useContext } from "react"

export const ChatPlaceScope = createContext("")

/** The URL key for one of this chat's choices. */
export const chatPlaceKey = (scope: string, key: string) => (scope === "" ? key : `${scope}.${key}`)

export const useChatPlaceKey = (key: string) => chatPlaceKey(useContext(ChatPlaceScope), key)
