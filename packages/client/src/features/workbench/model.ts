// What the center column holds (owner, 2026-11-05; DESIGN §10.1): frames side by side or
// above each other, each with its tabs and the one shown. Pure functions over immutable data,
// so the store, the persistence and the tests share one set of rules.

export interface Tab {
  readonly id: string
  /** The view's own URL: what its router shows, and the browser's while it's focused. */
  readonly href: string
  /** Opened by a single click: the next single-click open replaces it (shown in italics). */
  readonly preview: boolean
}

export interface Frame {
  readonly type: "frame"
  readonly id: string
  readonly tabs: ReadonlyArray<Tab>
  /** The tab shown; null only while the frame is empty (just split off). */
  readonly active: string | null
}

export type Direction = "row" | "column"

export interface Split {
  readonly type: "split"
  readonly id: string
  /** `row`: side by side (split along a vertical line); `column`: one above the other. */
  readonly direction: Direction
  readonly children: ReadonlyArray<Node>
  /** Each child's share of the split, summing to 1. */
  readonly sizes: ReadonlyArray<number>
}

export type Node = Frame | Split

export interface Layout {
  readonly root: Node
  /** The frame last focused: where opening goes, and the one the side panels follow. */
  readonly focused: string
  /** Tab ids, most recently focused first: what closing returns to. */
  readonly recent: ReadonlyArray<string>
}

/** Which item a URL shows (a chat, an entry's editor, a page): one tab per item. */
export type KeyOf = (href: string) => string

let counter = 0
/** Ids unique within this page and unlikely to meet a saved layout's. */
export const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const frameNode = (tabs: ReadonlyArray<Tab>, id = newId("f")): Frame => ({
  type: "frame",
  id,
  tabs,
  active: tabs[0]?.id ?? null
})

export const initialLayout = (href: string): Layout => {
  const tab: Tab = { id: newId("t"), href, preview: true }
  const frame = frameNode([tab])
  return { root: frame, focused: frame.id, recent: [tab.id] }
}

export const frames = (node: Node): ReadonlyArray<Frame> =>
  node.type === "frame" ? [node] : node.children.flatMap(frames)

export const allTabs = (layout: Layout): ReadonlyArray<Tab> => frames(layout.root).flatMap((f) => f.tabs)

export const findFrame = (layout: Layout, frameId: string) => frames(layout.root).find((f) => f.id === frameId)

export const frameOfTab = (layout: Layout, tabId: string) =>
  frames(layout.root).find((f) => f.tabs.some((t) => t.id === tabId))

export const findTab = (layout: Layout, tabId: string) => allTabs(layout).find((t) => t.id === tabId)

export const focusedFrame = (layout: Layout): Frame => findFrame(layout, layout.focused) ?? frames(layout.root)[0]!

/** The tab the browser's URL names: the focused frame's shown tab. */
export const focusedTab = (layout: Layout): Tab | undefined => {
  const frame = focusedFrame(layout)
  return frame.tabs.find((t) => t.id === frame.active)
}

export const isSplit = (layout: Layout) => layout.root.type === "split"

const mapNode = (node: Node, f: (frame: Frame) => Node | null): Node | null => {
  if (node.type === "frame") return f(node)
  const kept: Array<{ child: Node; size: number }> = []
  node.children.forEach((child, i) => {
    const next = mapNode(child, f)
    if (next) kept.push({ child: next, size: node.sizes[i] ?? 1 / node.children.length })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!.child
  const total = kept.reduce((sum, k) => sum + k.size, 0) || 1
  // A child split the same way joins its parent: one row of three, not a row in a row.
  const children: Array<Node> = []
  const sizes: Array<number> = []
  for (const k of kept) {
    if (k.child.type === "split" && k.child.direction === node.direction) {
      k.child.children.forEach((c, i) => {
        children.push(c)
        sizes.push((k.size / total) * (k.child.type === "split" ? (k.child.sizes[i] ?? 0) : 1))
      })
    } else {
      children.push(k.child)
      sizes.push(k.size / total)
    }
  }
  return { ...node, children, sizes }
}

const updateFrames = (layout: Layout, f: (frame: Frame) => Node | null): Layout => {
  const root = mapNode(layout.root, f) ?? frameNode([])
  const live = frames(root)
  const focused = live.some((fr) => fr.id === layout.focused) ? layout.focused : (live[0]?.id ?? "")
  const ids = new Set(live.flatMap((fr) => fr.tabs.map((t) => t.id)))
  return { root, focused, recent: layout.recent.filter((id) => ids.has(id)) }
}

const touch = (recent: ReadonlyArray<string>, tabId: string) => [tabId, ...recent.filter((id) => id !== tabId)]

/** Shows a tab in its frame and focuses that frame. */
export const focusTab = (layout: Layout, tabId: string): Layout => {
  const frame = frameOfTab(layout, tabId)
  if (!frame) return layout
  if (frame.active === tabId && layout.focused === frame.id && layout.recent[0] === tabId) return layout
  const next = updateFrames(layout, (f) => (f.id === frame.id ? { ...f, active: tabId } : f))
  return { ...next, focused: frame.id, recent: touch(next.recent, tabId) }
}

export const focusFrame = (layout: Layout, frameId: string): Layout => {
  const frame = findFrame(layout, frameId)
  if (!frame) return layout
  if (frame.active) return focusTab(layout, frame.active)
  return layout.focused === frameId ? layout : { ...layout, focused: frameId }
}

/** Keeps a preview tab open: the next single-click open adds a tab beside it. */
export const pinTab = (layout: Layout, tabId: string): Layout => {
  const tab = findTab(layout, tabId)
  if (!tab?.preview) return layout
  return updateFrames(layout, (f) => ({
    ...f,
    tabs: f.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t))
  }))
}

export const setTabHref = (layout: Layout, tabId: string, href: string): Layout => {
  const tab = findTab(layout, tabId)
  if (!tab || tab.href === href) return layout
  return updateFrames(layout, (f) => ({ ...f, tabs: f.tabs.map((t) => (t.id === tabId ? { ...t, href } : t)) }))
}

export interface OpenOptions {
  /** A single click's open (default): replaces the frame's preview tab. */
  readonly preview?: boolean
  /** The frame to open in; the focused one by default. */
  readonly frame?: string
  /** Opens without focusing (a chat restored behind its editor). */
  readonly background?: boolean
  /** The new tab's id, when the caller needs to know it. */
  readonly id?: string
}

/**
 * Opens an item: an open tab with the same item is focused and shown at `href`; else the
 * item opens in the frame, in place of its preview tab (VS Code reuses the preview's place
 * for any open), else beside the shown tab.
 */
export const openTab = (layout: Layout, href: string, keyOf: KeyOf, options: OpenOptions = {}): Layout => {
  const preview = options.preview ?? true
  const key = keyOf(href)
  const existing = allTabs(layout).find((t) => keyOf(t.href) === key)
  if (existing) {
    let next = setTabHref(layout, existing.id, href)
    if (!preview) next = pinTab(next, existing.id)
    return options.background ? next : focusTab(next, existing.id)
  }
  const target = (options.frame && findFrame(layout, options.frame)) || focusedFrame(layout)
  const tab: Tab = { id: options.id ?? newId("t"), href, preview }
  const next = updateFrames(layout, (f) => {
    if (f.id !== target.id) return f
    const previewAt = f.tabs.findIndex((t) => t.preview)
    if (previewAt >= 0) {
      const tabs = [...f.tabs]
      tabs[previewAt] = tab
      return { ...f, tabs, active: options.background && f.active !== tabs[previewAt]?.id ? f.active : tab.id }
    }
    const at = f.tabs.findIndex((t) => t.id === f.active)
    const tabs = [...f.tabs.slice(0, at + 1), tab, ...f.tabs.slice(at + 1)]
    return { ...f, tabs, active: options.background && f.active ? f.active : tab.id }
  })
  if (options.background) return { ...next, recent: [...next.recent, tab.id] }
  return focusTab(next, tab.id)
}

/** The most recently focused of these tabs, else the one nearest `fallback`'s place. */
const mostRecent = (recent: ReadonlyArray<string>, tabs: ReadonlyArray<Tab>, index: number) =>
  recent.find((id) => tabs.some((t) => t.id === id)) ?? tabs[Math.min(index, tabs.length - 1)]?.id ?? null

/**
 * Closes a tab. Its frame shows the tab focused before it; a frame left empty closes, unless
 * it's the only one.
 */
export const closeTab = (layout: Layout, tabId: string): Layout => {
  const frame = frameOfTab(layout, tabId)
  if (!frame) return layout
  const index = frame.tabs.findIndex((t) => t.id === tabId)
  const tabs = frame.tabs.filter((t) => t.id !== tabId)
  const recent = layout.recent.filter((id) => id !== tabId)
  const only = frames(layout.root).length === 1
  const next = updateFrames({ ...layout, recent }, (f) => {
    if (f.id !== frame.id) return f
    if (tabs.length === 0 && !only) return null
    return { ...f, tabs, active: f.active === tabId ? mostRecent(recent, tabs, index) : f.active }
  })
  // Focus moves to the frame focused before, when this frame went.
  if (!findFrame(next, frame.id)) {
    const back = recent.map((id) => frameOfTab(next, id)).find((f) => f !== undefined)
    return back ? { ...next, focused: back.id } : next
  }
  return next
}

/** Closes a frame and its tabs. */
export const closeFrame = (layout: Layout, frameId: string): Layout => {
  if (frames(layout.root).length === 1) return layout
  const closed = findFrame(layout, frameId)
  if (!closed) return layout
  const gone = new Set(closed.tabs.map((t) => t.id))
  const recent = layout.recent.filter((id) => !gone.has(id))
  const next = updateFrames({ ...layout, recent }, (f) => (f.id === frameId ? null : f))
  const back = recent.map((id) => frameOfTab(next, id)).find((f) => f !== undefined)
  return back ? { ...next, focused: back.id } : next
}

const insertTab = (f: Frame, tab: Tab, index?: number): Frame => {
  const tabs = f.tabs.filter((t) => t.id !== tab.id)
  const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length))
  return { ...f, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], active: tab.id }
}

/** Moves a tab to another frame (or to another place in its own), shown and focused there. */
export const moveTab = (layout: Layout, tabId: string, frameId: string, index?: number): Layout => {
  const tab = findTab(layout, tabId)
  const from = frameOfTab(layout, tabId)
  if (!tab || !from || !findFrame(layout, frameId)) return layout
  if (from.id === frameId) {
    const next = updateFrames(layout, (f) => (f.id === frameId ? insertTab(f, tab, index) : f))
    return focusTab(next, tabId)
  }
  const rest = from.tabs.filter((t) => t.id !== tabId)
  const fromIndex = from.tabs.findIndex((t) => t.id === tabId)
  const next = updateFrames(layout, (f) => {
    if (f.id === frameId) return insertTab(f, tab, index)
    if (f.id !== from.id) return f
    if (rest.length === 0) return null
    return { ...f, tabs: rest, active: f.active === tabId ? mostRecent(layout.recent, rest, fromIndex) : f.active }
  })
  return focusTab(next, tabId)
}

/**
 * Splits a frame: a new frame beside it (`row`) or below it (`column`), focused. It takes the
 * shown tab when the frame has others to show; else it starts empty, for the next open.
 */
export const splitFrame = (layout: Layout, frameId: string, direction: Direction, newFrameId = newId("f")): Layout => {
  const frame = findFrame(layout, frameId)
  if (!frame) return layout
  const moving = frame.tabs.length > 1 ? frame.tabs.find((t) => t.id === frame.active) : undefined
  const added = frameNode(moving ? [moving] : [], newFrameId)
  const replace = (node: Node): Node => {
    if (node.type === "frame") {
      if (node.id !== frameId) return node
      const kept: Frame = moving
        ? {
            ...node,
            tabs: node.tabs.filter((t) => t.id !== moving.id),
            active: mostRecent(
              layout.recent.filter((id) => id !== moving.id),
              node.tabs.filter((t) => t.id !== moving.id),
              node.tabs.findIndex((t) => t.id === moving.id)
            )
          }
        : node
      return { type: "split", id: newId("s"), direction, children: [kept, added], sizes: [0.5, 0.5] }
    }
    const at = node.children.findIndex((c) => c.type === "frame" && c.id === frameId)
    if (at >= 0 && node.direction === direction) {
      const kept = replace(node.children[at]!) as Split
      const half = (node.sizes[at] ?? 0) / 2
      return {
        ...node,
        children: [...node.children.slice(0, at), kept.children[0]!, added, ...node.children.slice(at + 1)],
        sizes: [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)]
      }
    }
    return { ...node, children: node.children.map(replace) }
  }
  const root = replace(layout.root)
  const next = { ...layout, root, focused: added.id }
  return moving ? focusTab(next, moving.id) : next
}

/** Sets a split's shares, each at least `min`. */
export const resizeSplit = (layout: Layout, splitId: string, sizes: ReadonlyArray<number>): Layout => {
  const visit = (node: Node): Node => {
    if (node.type === "frame") return node
    if (node.id === splitId && sizes.length === node.children.length) {
      const total = sizes.reduce((a, b) => a + b, 0) || 1
      return { ...node, sizes: sizes.map((s) => s / total) }
    }
    return { ...node, children: node.children.map(visit) }
  }
  return { ...layout, root: visit(layout.root) }
}

/** The frames beside one, for "Move to the frame on the right" and its kin. */
export const neighbours = (layout: Layout, frameId: string) => {
  const result: Partial<Record<"left" | "right" | "up" | "down", string>> = {}
  const nearest = (node: Node, edge: "first" | "last"): Frame =>
    node.type === "frame" ? node : nearest(edge === "first" ? node.children[0]! : node.children.at(-1)!, edge)
  const walk = (node: Node, ancestors: ReadonlyArray<{ split: Split; index: number }>) => {
    if (node.type === "split") {
      node.children.forEach((child, index) => walk(child, [...ancestors, { split: node, index }]))
      return
    }
    if (node.id !== frameId) return
    for (const { split, index } of [...ancestors].reverse()) {
      const before = split.direction === "row" ? "left" : "up"
      const after = split.direction === "row" ? "right" : "down"
      if (index > 0 && !result[before]) result[before] = nearest(split.children[index - 1]!, "last").id
      if (index < split.children.length - 1 && !result[after])
        result[after] = nearest(split.children[index + 1]!, "first").id
    }
  }
  walk(layout.root, [])
  return result
}

/** The frames touching the column's left edge (where the hidden sidebar's button goes). */
export const leftEdgeFrames = (node: Node): ReadonlySet<string> => {
  if (node.type === "frame") return new Set([node.id])
  if (node.direction === "row") return leftEdgeFrames(node.children[0]!)
  return new Set(node.children.flatMap((c) => [...leftEdgeFrames(c)]))
}

// --- Saved layouts: whatever is read is repaired into a valid layout, or dropped.

const MAX_TABS = 60
const MAX_DEPTH = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A saved layout, repaired: unknown or broken parts are left out. Null when nothing usable. */
export const restoreLayout = (value: unknown, accept: (href: string) => boolean = () => true): Layout | null => {
  if (!isRecord(value) || value["version"] !== 1) return null
  const seen = new Set<string>()
  const seenFrames = new Set<string>()
  let count = 0
  const node = (raw: unknown, depth: number): Node | null => {
    if (!isRecord(raw) || depth > MAX_DEPTH) return null
    if (raw["type"] === "frame" && typeof raw["id"] === "string" && !seenFrames.has(raw["id"])) {
      seenFrames.add(raw["id"])
      const tabs: Array<Tab> = []
      for (const t of Array.isArray(raw["tabs"]) ? raw["tabs"] : []) {
        if (!isRecord(t) || typeof t["id"] !== "string" || typeof t["href"] !== "string") continue
        if (seen.has(t["id"]) || !t["href"].startsWith("/") || !accept(t["href"]) || count >= MAX_TABS) continue
        seen.add(t["id"])
        count++
        tabs.push({ id: t["id"], href: t["href"], preview: t["preview"] === true })
      }
      const active = tabs.some((t) => t.id === raw["active"]) ? (raw["active"] as string) : (tabs[0]?.id ?? null)
      return { type: "frame", id: raw["id"], tabs, active }
    }
    if (raw["type"] === "split" && typeof raw["id"] === "string" && (raw["direction"] === "row" || raw["direction"] === "column")) {
      const children = (Array.isArray(raw["children"]) ? raw["children"] : []).map((c) => node(c, depth + 1))
      const sizes = Array.isArray(raw["sizes"]) ? raw["sizes"] : []
      const kept = children.flatMap((c, i) => {
        if (!c || (c.type === "frame" && c.tabs.length === 0)) return []
        const size = sizes[i]
        return [{ c, size: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 1 }]
      })
      if (kept.length === 0) return null
      if (kept.length === 1) return kept[0]!.c
      const total = kept.reduce((s, k) => s + k.size, 0)
      return {
        type: "split",
        id: raw["id"],
        direction: raw["direction"],
        children: kept.map((k) => k.c),
        sizes: kept.map((k) => k.size / total)
      }
    }
    return null
  }
  const root = node(value["root"], 0)
  if (!root || allTabs({ root, focused: "", recent: [] }).length === 0) return null
  // Normalized through the same rules every change uses (one row of three, not nested).
  const layout = updateFrames({ root, focused: "", recent: [] }, (f) => f)
  const live = frames(layout.root)
  const focused = live.some((f) => f.id === value["focused"]) ? (value["focused"] as string) : live[0]!.id
  const ids = new Set(allTabs(layout).map((t) => t.id))
  const recent = (Array.isArray(value["recent"]) ? value["recent"] : []).filter(
    (id): id is string => typeof id === "string" && ids.has(id)
  )
  return { ...layout, focused, recent: [...new Set(recent)] }
}

export const saveLayout = (layout: Layout, persist: (href: string) => string | null = (h) => h) => {
  const node = (n: Node): unknown =>
    n.type === "frame"
      ? {
          type: "frame",
          id: n.id,
          active: n.active,
          tabs: n.tabs.flatMap((t) => {
            const href = persist(t.href)
            return href === null ? [] : [{ id: t.id, href, preview: t.preview }]
          })
        }
      : { type: "split", id: n.id, direction: n.direction, sizes: n.sizes, children: n.children.map(node) }
  return { version: 1, root: node(layout.root), focused: layout.focused, recent: layout.recent.slice(0, MAX_TABS) }
}
