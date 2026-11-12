import { chatBrowseSearch } from "./chatBrowseSearch.ts"
/**
 * The search params that say what the left panel shows (ARCHITECTURE §12): `character` scopes
 * it to a card's chats, `forks` to one chat's forks, `side=characters` shows the character grid.
 * The panel reads them from the URL and nowhere else. Screens the panel's picks open register
 * them as `retainSearch`, so moving around inside such a screen keeps the panel where it is.
 */
export const sidebarSearch = [
  ...chatBrowseSearch,
  "character",
  "forks",
  "side",
  "sideShow",
  "sideSort",
  "sideReverse",
  "sidePersonas",
  "sideQ",
  // The chat search looks through message text (MessageSearch.tsx).
  "sideIn",
  "sidePinsSort",
  // A card source's query (spec/CARD-SOURCES.md §3.2).
  "sideSq",
  "sideStags",
  "sideSxtags",
  "sideSf",
  "sideSsort",
  "sideSreverse"
] as const
