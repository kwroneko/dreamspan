// "Open beside" (VS Code's Open to the Side) for any opener: an event the workbench listens for
// (features/workbench/Workbench.tsx), so it works wherever it's rendered, inside the
// workbench's context or not, and the shared menus here can offer it.
import { useSyncExternalStore } from "react"

export const OPEN_BESIDE = "rp:open-beside"

/** Opens `href` in the frame right of the focused one, adding one if there's none. */
export const openBeside = (href: string) => window.dispatchEvent(new CustomEvent(OPEN_BESIDE, { detail: href }))

const WIDE = "(min-width: 1024px)"
const subscribe = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
/** Whether frames can sit side by side here (a phone has one). */
export const useCanOpenBeside = () => useSyncExternalStore(subscribe, () => matchMedia(WIDE).matches)

export const OPEN_BESIDE_HINT =
  "Opens it in the frame on the right, adding one if there's none. Alt-click a link to do the same."

/** The explanations of a link's other two open items, as the chat rows' menu has them. */
export const OPEN_HERE_HINT = "Opens it here, as a click does."
export const OPEN_NEW_TAB_HINT = "Opens it in a new browser tab."
