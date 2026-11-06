// True inside a view that is open but not on screen (a workbench tab behind another). Its
// dialogs and popovers close while it's away and open again when it's shown: they render at
// the page's top level, so they'd otherwise cover what is on screen.
import { createContext, use } from "react"

export const Away = createContext(false)

export const useAway = () => use(Away)
