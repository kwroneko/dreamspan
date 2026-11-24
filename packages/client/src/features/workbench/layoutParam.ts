// A browser tab's frames and tabs in its URL (owner, 2026-11-18: layout "has to be in the URL"):
// the layout param `wb`, absent while the column shows a lone preview. Compact JSON, so a
// reload, a copied link or a duplicated browser tab opens the same
// frames, and nothing is kept in browser storage.
//
// A frame is `[active index, ...tabs]`; a split is `["r" | "c", [shares], ...children]` (`r`
// side by side, `c` above each other). A tab is its URL, with `~` before it for a preview tab
// and `^` for a pinned one; the focused tab is `=` (with the same marks): the browser's own URL,
// so the focused tab's navigation never changes the param. Ids are made afresh on reading.
import { allTabs, focusedTab, type Layout, MAX_SAVED_TABS, newId, type Node } from "./model.ts"
import { compactHref } from "./kinds.ts"

export const WORKBENCH_PARAM = "wb"

const mark = (tab: { readonly preview: boolean; readonly sticky?: boolean }) =>
  tab.sticky ? "^" : tab.preview ? "~" : ""

/**
 * The param for `layout`, or null for a lone preview. `persist` gives what a tab's URL keeps
 * (null: left out, a login page); `strip` takes the browser's own params off a tab's URL.
 */
export const encodeLayout = (
  layout: Layout,
  persist: (href: string) => string | null,
  strip: (href: string) => string = (href) => href,
  limit = WB_LIMIT
): string | null => {
  const tabs = allTabs(layout)
  const focused = focusedTab(layout)
  if (!focused || (tabs.length === 1 && mark(focused) === "~") || persist(focused.href) === null) return null
  const hidden = new Map<string, string>()
  for (const tab of tabs) {
    if (tab.id === focused.id) continue
    const href = persist(tab.href)
    if (href !== null) hidden.set(tab.id, strip(href))
  }
  const evictionOrder = leastRecent([...hidden.keys()], layout.recent)
  const excess = Math.max(0, hidden.size + 1 - MAX_SAVED_TABS)
  for (const id of evictionOrder.slice(0, excess)) hidden.delete(id)
  const text = () => JSON.stringify(node(layout.root))
  const node = (n: Node): Array<unknown> | null => {
    if (n.type === "split") {
      const children = n.children.flatMap((child, i) => {
        const encoded = node(child)
        return encoded === null ? [] : [{ encoded, size: n.sizes[i]! }]
      })
      if (children.length <= 1) return children[0]?.encoded ?? null
      const total = children.length === n.children.length ? 1 : children.reduce((sum, child) => sum + child.size, 0)
      return [
        n.direction === "row" ? "r" : "c",
        children.map(({ size }) => Math.round((size / total) * 1000) / 1000),
        ...children.map(({ encoded }) => encoded)
      ]
    }
    const tabs = n.tabs.flatMap((t) => {
      if (t.id === focused.id) return [{ id: t.id, text: `=${mark(t)}` }]
      const href = hidden.get(t.id)
      return href === undefined ? [] : [{ id: t.id, text: `${mark(t)}${href}` }]
    })
    if (tabs.length === 0) return null
    const active = Math.max(
      0,
      tabs.findIndex((t) => t.id === n.active)
    )
    return [active, ...tabs.map((t) => t.text)]
  }
  let json = text()
  if (encodedLength(json) <= limit) return json
  // Too long for a URL a server or proxy takes back (8 KB headers): the tabs of frames other
  // than the focused one lose their place params, least recently focused first, until it fits;
  // the focused frame's hidden tabs only after all of those.
  for (const id of droppable(layout)) {
    const href = hidden.get(id)
    if (href === undefined) continue
    const compact = compactHref(href)
    if (compact === href) continue
    hidden.set(id, compact)
    json = text()
    if (encodedLength(json) <= limit) return json
  }
  // The essentials still don't fit: omit least-recent tabs from the saved URL.
  for (const id of evictionOrder.slice(excess)) {
    hidden.delete(id)
    json = text()
    if (encodedLength(json) <= limit) return json
  }
  return null
}

/** The param's budget, encoded: the whole URL stays well under 8 KB with the page's own params. */
export const WB_LIMIT = 4096

const encodedLength = (json: string) => new URLSearchParams({ [WORKBENCH_PARAM]: json }).toString().length

const leastRecent = (ids: Array<string>, recent: ReadonlyArray<string>) => {
  const ranks = new Map(recent.map((id, i) => [id, i]))
  const rank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER
  return ids.sort((a, b) => rank(b) - rank(a))
}

/**
 * Tabs outside the focused frame, least recently focused first (never-focused ones before them);
 * only then, if that isn't enough, the focused frame's hidden tabs in the same order. The focused
 * tab is the browser's own URL, never in the param.
 */
const droppable = (layout: Layout) => {
  const outside: Array<string> = []
  const inside: Array<string> = []
  ;(function walk(n: Node) {
    if (n.type === "frame") (n.id === layout.focused ? inside : outside).push(...n.tabs.map((t) => t.id))
    else n.children.forEach(walk)
  })(layout.root)
  return [...leastRecent(outside, layout.recent), ...leastRecent(inside, layout.recent)]
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
