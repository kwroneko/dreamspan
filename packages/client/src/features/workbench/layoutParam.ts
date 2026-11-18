// A browser tab's frames and tabs in its URL (owner, 2026-11-18: layout "has to be in the URL"):
// the layout param `wb`, absent while the column shows one tab alone (the URL is then the whole
// layout). Compact JSON, so a reload, a copied link or a duplicated browser tab opens the same
// frames, and nothing is kept in browser storage.
//
// A frame is `[active index, ...tabs]`; a split is `["r" | "c", [shares], ...children]` (`r`
// side by side, `c` above each other). A tab is its URL, with `~` before it for a preview tab
// and `^` for a pinned one; the focused tab is `=` (with the same marks): the browser's own URL,
// so the focused tab's navigation never changes the param. Ids are made afresh on reading.
import { allTabs, type Layout, newId, type Node } from "./model.ts"

export const WORKBENCH_PARAM = "wb"

const mark = (tab: { readonly preview: boolean; readonly sticky?: boolean }) =>
  tab.sticky ? "^" : tab.preview ? "~" : ""

/**
 * The param for `layout`, or null when it's one tab alone. `persist` gives what a tab's URL keeps
 * (null: left out, a login page); `strip` takes the browser's own params off a tab's URL.
 */
export const encodeLayout = (
  layout: Layout,
  persist: (href: string) => string | null,
  strip: (href: string) => string = (href) => href
): string | null => {
  if (allTabs(layout).length <= 1) return null
  const focused = focusedId(layout)
  const node = (n: Node): unknown => {
    if (n.type === "split")
      return [
        n.direction === "row" ? "r" : "c",
        n.sizes.map((s) => Math.round(s * 1000) / 1000),
        ...n.children.map(node)
      ]
    const tabs = n.tabs.flatMap((t) => {
      if (t.id === focused) return [{ id: t.id, text: `=${mark(t)}` }]
      const href = persist(t.href)
      return href === null ? [] : [{ id: t.id, text: `${mark(t)}${strip(href)}` }]
    })
    const active = Math.max(
      0,
      tabs.findIndex((t) => t.id === n.active)
    )
    return [active, ...tabs.map((t) => t.text)]
  }
  return JSON.stringify(node(layout.root))
}

const focusedId = (layout: Layout) => {
  const frame = (function find(n: Node): Node | undefined {
    if (n.type === "frame") return n.id === layout.focused ? n : undefined
    for (const child of n.children) {
      const found = find(child)
      if (found) return found
    }
    return undefined
  })(layout.root)
  return frame?.type === "frame" ? frame.active : null
}

/**
 * The saved-layout shape `restoreLayout` repairs, from the param; the focused tab (`=`) at
 * `href`, the browser's URL. Null when the param is absent or unreadable.
 */
export const decodeLayout = (text: string | null, href: string): unknown => {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  let focused: { frame: string; tab: string } | null = null
  const node = (value: unknown, depth: number): unknown => {
    if (!Array.isArray(value) || depth > 8) return null
    const [head, ...rest] = value as Array<unknown>
    if (head === "r" || head === "c") {
      const [sizes, ...children] = rest
      return {
        type: "split",
        id: newId("s"),
        direction: head === "r" ? "row" : "column",
        sizes: Array.isArray(sizes) ? sizes : [],
        children: children.map((c) => node(c, depth + 1))
      }
    }
    if (typeof head !== "number") return null
    const id = newId("f")
    const tabs = rest.flatMap((t) => {
      if (typeof t !== "string") return []
      const sticky = t.startsWith("=^") || t.startsWith("^")
      const preview = t.startsWith("=~") || t.startsWith("~")
      const own = t.startsWith("=")
      const tabHref = own ? href : t.slice(sticky || preview ? 1 : 0)
      const tab = { id: newId("t"), href: tabHref, preview, ...(sticky ? { sticky } : {}) }
      if (own && focused === null) focused = { frame: id, tab: tab.id }
      return [tab]
    })
    // The browser's URL is the one shown: its frame shows it, whatever the index says.
    const own =
      focused !== null && (focused as { frame: string }).frame === id ? (focused as { tab: string }).tab : null
    const active = own ?? tabs[Math.min(Math.max(0, Math.trunc(head)), tabs.length - 1)]?.id ?? null
    return { type: "frame", id, tabs, active }
  }
  const root = node(raw, 0)
  if (root === null) return null
  const found = focused as { frame: string; tab: string } | null
  return { version: 1, root, focused: found?.frame ?? null, recent: found ? [found.tab] : [] }
}
