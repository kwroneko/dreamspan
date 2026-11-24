// "Open beside" (VS Code's Open to the Side) for any opener: an event the workbench listens for
// (features/workbench/Workbench.tsx), so it works wherever it's rendered, inside the
// workbench's context or not, and the shared menus here can offer it.
import { useSyncExternalStore } from "react"

export const OPEN_BESIDE = "rp:open-beside"

/** Opens `href` in the frame right of the focused one, adding one if there's none. */
export const openBeside = (href: string) => window.dispatchEvent(new CustomEvent(OPEN_BESIDE, { detail: href }))

/**
 * A card's page beside (owner, 2026-11-24: reading card after card): as a preview tab in the
 * frame on the right, which the next one replaces; focus stays with the opener.
 */
export const openPageBeside = (href: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_BESIDE, { detail: { href, preview: true } }))

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

/** A card's own page beside (owner, 2026-11-24): its editor, or a card source's read-only page. */
export const PAGE_BESIDE_HINT = "Open this card's page in the pane next to this one."

/** A card source's card in the full editor beside (owner, 2026-11-24), for reading card after card. */
export const EDITOR_BESIDE_HINT = "Shows every field in the editor, in the pane next to this one."

/** The explanations of a link's other two open items, as the chat rows' menu has them. */
export const OPEN_HERE_HINT = "Opens it here, as a click does."
export const OPEN_NEW_TAB_HINT = "Opens it in a new browser tab."
