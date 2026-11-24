// What the center column holds (owner, 2026-11-05; DESIGN §10.1): frames side by side or
// above each other, each with its tabs and the one shown. Pure functions over immutable data,
// so the store, the persistence and the tests share one set of rules.

export interface Tab {
  readonly id: string
  /** The view's own URL: what its router shows, and the browser's while it's focused. */
  readonly href: string
  /** Opened by a single click: the next single-click open replaces it (shown in italics). */
  readonly preview: boolean
  /** VS Code's pinned tab: first in its frame, kept by Close others, to the right and all. */
  readonly sticky?: boolean
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
  /** The frame shown alone, the others kept (VS Code's Maximize Editor Group); not saved. */
  readonly maximized?: string
}

/**
 * Which item a URL shows (a chat, an entry's editor, a page): one tab per item in a frame. Two
 * frames can each show the same item (VS Code's editor groups: Split, or a drag to another).
 */
export type KeyOf = (href: string) => string

let counter = 0
/** Ids unique within this page and unlikely to meet a saved layout's. */
export const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

const frameNode = (tabs: ReadonlyArray<Tab>, id = newId("f")): Frame => ({
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

// A plain walk: the menus run the layout's functions for every item each time they open
// (`canApply`), and `flatMap` over the tree was most of that time.
export const frames = (node: Node): ReadonlyArray<Frame> => {
  if (node.type === "frame") return [node]
  const found: Array<Frame> = []
  const walk = (n: Node) => {
    if (n.type === "frame") found.push(n)
    else for (const child of n.children) walk(child)
  }
  walk(node)
  return found
}

export const allTabs = (layout: Layout): ReadonlyArray<Tab> => frames(layout.root).flatMap((f) => f.tabs)

const findFrame = (layout: Layout, frameId: string) => frames(layout.root).find((f) => f.id === frameId)

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
  const ids = new Set<string>()
  for (const fr of live) for (const t of fr.tabs) ids.add(t.id)
  const maximized = live.length > 1 && live.some((fr) => fr.id === layout.maximized) ? layout.maximized : undefined
  return {
    root,
    focused,
    recent: layout.recent.filter((id) => ids.has(id)),
    ...(maximized ? { maximized } : {})
  }
}

const touch = (recent: ReadonlyArray<string>, tabId: string) => [tabId, ...recent.filter((id) => id !== tabId)]

/** Shows a tab in its frame and focuses that frame. */
export const focusTab = (layout: Layout, tabId: string): Layout => {
  const frame = frameOfTab(layout, tabId)
  if (!frame) return layout
  if (frame.active === tabId && layout.focused === frame.id && layout.recent[0] === tabId) return layout
  const next = updateFrames(layout, (f) => (f.id === frame.id ? { ...f, active: tabId } : f))
  // A frame hidden behind a maximized one comes back with all of them.
  const { maximized, ...rest } = next
  const kept = maximized === frame.id ? { maximized } : {}
  return { ...rest, ...kept, focused: frame.id, recent: touch(next.recent, tabId) }
}

export const focusFrame = (layout: Layout, frameId: string): Layout => {
  const frame = findFrame(layout, frameId)
  if (!frame) return layout
  if (frame.active) return focusTab(layout, frame.active)
  if (layout.focused === frameId) return layout
  const { maximized, ...rest } = layout
  return { ...rest, ...(maximized === frameId ? { maximized } : {}), focused: frameId }
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

/** Pins or unpins a tab (VS Code's Pin): pinned tabs come first, in the order pinned. */
export const stickTab = (layout: Layout, tabId: string, sticky: boolean): Layout => {
  const tab = findTab(layout, tabId)
  if (!tab || (tab.sticky ?? false) === sticky) return layout
  return updateFrames(layout, (f) => {
    if (!f.tabs.some((t) => t.id === tabId)) return f
    const { sticky: _, ...plain } = tab
    const changed: Tab = sticky ? { ...plain, preview: false, sticky: true } : { ...plain, preview: false }
    // Pinned: last of the pinned; unpinned: first of the rest.
    const rest = f.tabs.filter((t) => t.id !== tabId)
    return { ...f, tabs: [...rest.filter((t) => t.sticky), changed, ...rest.filter((t) => !t.sticky)] }
  })
}

/** Which tabs a "Close …" closes, beside `tabId` in its frame; pinned tabs are kept. */
export type CloseWhich = "others" | "right" | "all" | "saved"

export const closeTabs = (
  layout: Layout,
  tabId: string,
  which: CloseWhich,
  unsaved: (tabId: string) => boolean = () => false
): Layout => {
  const frame = frameOfTab(layout, tabId)
  if (!frame) return layout
  const at = frame.tabs.findIndex((t) => t.id === tabId)
  const closing = frame.tabs.filter((t, index) => {
    if (t.sticky) return false
    if (which === "others") return t.id !== tabId
    if (which === "right") return index > at
    if (which === "saved") return !unsaved(t.id)
    return true
  })
  let next = layout
  for (const t of closing) next = closeTab(next, t.id)
  return findTab(next, tabId) ? focusTab(next, tabId) : next
}

/** Shows a frame alone, or all of them again (`null`). */
export const maximizeFrame = (layout: Layout, frameId: string | null): Layout => {
  const { maximized: _, ...rest } = layout
  if (frameId === null || !findFrame(layout, frameId) || frames(layout.root).length < 2) return rest
  return { ...rest, maximized: frameId, focused: frameId }
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
  /**
   * Kind affinity (`TabKind.opensWhereShown`): the group an item opens with, or null. Given, an
   * item of such a kind opens in the frame most recently focused whose shown tab is of its group,
   * in place of `frame` and the focused one; with none showing one, as without it.
   */
  readonly affinity?: AffinityOf
  /**
   * Affinity per open (spec/WORKSHOP-CARDS.md §7.3): tests on a frame's shown tab, tried in
   * order. The first that a shown tab passes names the frames to open in (one showing the item
   * first, else the one focused most recently), in place of `affinity`, `frame` and the focused
   * one; with none passing, as without it.
   */
  readonly near?: ReadonlyArray<ShownTest>
}

/** A test on a frame's shown tab's URL, for `OpenOptions.near`. */
export type ShownTest = (href: string) => boolean

/** The kind an item's tab opens beside (`TabKind.opensWhereShown`), or null when it has none. */
export type AffinityOf = (href: string) => string | null

/**
 * The frame an item with an affinity opens in: of the frames whose shown tab has the item's
 * group (a tab behind another doesn't count, nor a frame behind a maximized one), one already
 * showing the item, else the one focused most recently. Undefined when none shows one.
 */
export const affinityFrame = (layout: Layout, href: string, keyOf: KeyOf, affinity: AffinityOf) => {
  const group = affinity(href)
  if (group === null) return undefined
  return shownFrame(layout, href, keyOf, (shown) => affinity(shown) === group)
}

/** The first frame `near`'s tests find, in their order (`OpenOptions.near`). */
const nearFrame = (layout: Layout, href: string, keyOf: KeyOf, near: ReadonlyArray<ShownTest>) => {
  for (const test of near) {
    const frame = shownFrame(layout, href, keyOf, test)
    if (frame) return frame
  }
  return undefined
}

/**
 * Of the frames whose shown tab passes `test` (a frame behind a maximized one doesn't count),
 * the one already showing the item, else the one focused most recently.
 */
const shownFrame = (layout: Layout, href: string, keyOf: KeyOf, test: ShownTest) => {
  const shown = (f: Frame) => f.tabs.find((t) => t.id === f.active)
  const candidates = frames(layout.root).filter((f) => {
    if (layout.maximized && layout.maximized !== f.id) return false
    const tab = shown(f)
    return tab !== undefined && test(tab.href)
  })
  if (candidates.length === 0) return undefined
  const key = keyOf(href)
  const same = candidates.find((f) => keyOf(shown(f)!.href) === key)
  if (same) return same
  const rank = (f: Frame) => {
    if (f.id === layout.focused) return -1
    const at = layout.recent.findIndex((id) => f.tabs.some((t) => t.id === id))
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  return [...candidates].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * Opens an item: the frame's own tab with that item is focused and shown at `href`; with no
 * frame named, so is another frame's (VS Code's reveal if open); else the item opens in the
 * frame's preview tab, which keeps its id (VS Code reuses the preview for any open), else in a
 * new tab beside the shown one. With `affinity`, the frame is the one showing the item's kind
 * (`affinityFrame`) when there is one.
 */
export const openTab = (layout: Layout, href: string, keyOf: KeyOf, options: OpenOptions = {}): Layout =>
  openTabAt(layout, href, keyOf, options).layout

/** `openTab`, and the tab that shows the item. */
export const openTabAt = (
  layout: Layout,
  href: string,
  keyOf: KeyOf,
  options: OpenOptions = {}
): { layout: Layout; tabId: string } => {
  const preview = options.preview ?? true
  const key = keyOf(href)
  // An item of a kind with an affinity opens where its kind is shown (the request inspector
  // beside a chat), not in the opener's frame.
  const affine =
    (options.near ? nearFrame(layout, href, keyOf, options.near) : undefined) ??
    (options.affinity ? affinityFrame(layout, href, keyOf, options.affinity) : undefined)
  const target = affine ?? ((options.frame && findFrame(layout, options.frame)) || focusedFrame(layout))
  const existing =
    target.tabs.find((t) => keyOf(t.href) === key) ??
    (options.frame || affine ? undefined : allTabs(layout).find((t) => keyOf(t.href) === key))
  if (existing) {
    let next = setTabHref(layout, existing.id, href)
    if (!preview) next = pinTab(next, existing.id)
    return { layout: options.background ? next : focusTab(next, existing.id), tabId: existing.id }
  }
  // The preview tab takes the item in place (the same tab, as navigating did before tabs).
  const reused = target.tabs.find((t) => t.preview)
  const tab: Tab = { id: reused?.id ?? options.id ?? newId("t"), href, preview }
  const next = updateFrames(layout, (f) => {
    if (f.id !== target.id) return f
    const previewAt = f.tabs.findIndex((t) => t.preview)
    if (previewAt >= 0) {
      const tabs = [...f.tabs]
      tabs[previewAt] = tab
      return { ...f, tabs, active: options.background && f.active !== tab.id ? f.active : tab.id }
    }
    // After the shown tab, and after the pinned ones.
    const at = Math.max(
      f.tabs.findIndex((t) => t.id === f.active),
      f.tabs.findLastIndex((t) => t.sticky)
    )
    const tabs = [...f.tabs.slice(0, at + 1), tab, ...f.tabs.slice(at + 1)]
    return { ...f, tabs, active: options.background && f.active ? f.active : tab.id }
  })
  if (options.background)
    return { layout: reused ? next : { ...next, recent: [...next.recent, tab.id] }, tabId: tab.id }
  return { layout: focusTab(next, tab.id), tabId: tab.id }
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
  const from = f.tabs.findIndex((t) => t.id === tab.id)
  const tabs = f.tabs.filter((t) => t.id !== tab.id)
  // The strip reports a boundary in its original list, before removing the dragged tab.
  const boundary = index === undefined ? tabs.length : index - (from >= 0 && from < index ? 1 : 0)
  const pinned = tabs.filter((t) => t.sticky).length
  const at = tab.sticky ? Math.max(0, Math.min(boundary, pinned)) : Math.max(pinned, Math.min(boundary, tabs.length))
  // Moving deliberately keeps the tab; the destination can already have a preview.
  return { ...f, tabs: [...tabs.slice(0, at), { ...tab, preview: false }, ...tabs.slice(at)], active: tab.id }
}

/**
 * Moves a tab to another frame (or to another place in its own), shown and focused there. A
 * frame that has the item already shows its own tab, and the moved one closes.
 */
export const moveTab = (layout: Layout, tabId: string, frameId: string, index?: number, keyOf?: KeyOf): Layout => {
  const tab = findTab(layout, tabId)
  const from = frameOfTab(layout, tabId)
  const to = findFrame(layout, frameId)
  if (!tab || !from || !to) return layout
  const twin = keyOf && to.tabs.find((t) => t.id !== tabId && keyOf(t.href) === keyOf(tab.href))
  if (twin && from.id !== frameId) return focusTab(closeTab(layout, tabId), twin.id)
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

export interface SplitOptions {
  readonly newFrameId?: string
  /** The copy's id (VS Code's Split Editor: the new frame shows the shown tab's item too). */
  readonly copyId?: string
  /** Where the new frame goes: after the frame (right or below, the default) or before it. */
  readonly before?: boolean
  /** Empty, for a tab dropped there (`moveTab`) rather than a copy. */
  readonly empty?: boolean
}

/**
 * Splits a frame: a new frame beside it (`row`) or above or below it (`column`), focused,
 * showing a kept copy of the frame's shown tab, as VS Code's Split Editor does.
 */
export const splitFrame = (
  layout: Layout,
  frameId: string,
  direction: Direction,
  options: SplitOptions = {}
): Layout => {
  const frame = findFrame(layout, frameId)
  if (!frame) return layout
  const shown = options.empty ? undefined : frame.tabs.find((t) => t.id === frame.active)
  const copy: Tab | undefined = shown && { id: options.copyId ?? newId("t"), href: shown.href, preview: false }
  const added = frameNode(copy ? [copy] : [], options.newFrameId ?? newId("f"))
  const pair = (kept: Node) => (options.before ? [added, kept] : [kept, added])
  const replace = (node: Node): Node => {
    if (node.type === "frame") {
      if (node.id !== frameId) return node
      return { type: "split", id: newId("s"), direction, children: pair(node), sizes: [0.5, 0.5] }
    }
    const at = node.children.findIndex((c) => c.type === "frame" && c.id === frameId)
    if (at >= 0 && node.direction === direction) {
      const half = (node.sizes[at] ?? 0) / 2
      return {
        ...node,
        children: [...node.children.slice(0, at), ...pair(node.children[at]!), ...node.children.slice(at + 1)],
        sizes: [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)]
      }
    }
    return { ...node, children: node.children.map(replace) }
  }
  const root = replace(layout.root)
  const { maximized: _, ...rest } = layout
  const next = { ...rest, root, focused: added.id }
  return copy ? focusTab(next, copy.id) : next
}

/** The node beside a frame in its split: the one before it, else the one after. */
const siblingOf = (node: Node, frameId: string): Node | undefined => {
  if (node.type === "frame") return undefined
  const at = node.children.findIndex((c) => c.type === "frame" && c.id === frameId)
  if (at >= 0) return node.children[at - 1] ?? node.children[at + 1]
  for (const child of node.children) {
    const found = siblingOf(child, frameId)
    if (found) return found
  }
  return undefined
}

/** Puts a new frame beside a node (a frame or a whole split), as `splitFrame` does for a frame. */
const splitNode = (root: Node, nodeId: string, direction: Direction, added: Frame, before: boolean): Node => {
  const replace = (node: Node): Node => {
    if (node.id === nodeId) {
      const children = before ? [added, node] : [node, added]
      return { type: "split", id: newId("s"), direction, children, sizes: [0.5, 0.5] }
    }
    return node.type === "frame" ? node : { ...node, children: node.children.map(replace) }
  }
  return replace(root)
}

/**
 * Moves a tab into a new frame beside a frame (its own by default), on the right or below, or
 * on the left or above with `before`. A frame's only tab leaves first, as closing it would: its
 * frame closes and the node that took its place (the one before it, else after) is split, so
 * the only tab of the right frame of two, moved below, ends up below the left one. The only tab
 * of the only frame stays: closing it leaves nothing to split.
 */
export const moveToNewFrame = (
  layout: Layout,
  tabId: string,
  direction: Direction,
  options: { readonly frameId?: string; readonly before?: boolean; readonly newFrameId?: string } = {}
): Layout => {
  const tab = findTab(layout, tabId)
  const from = frameOfTab(layout, tabId)
  const target = options.frameId ?? from?.id
  if (!tab || !from || !target || !findFrame(layout, target)) return layout
  const added = frameNode([], options.newFrameId ?? newId("f"))
  const before = options.before ?? false
  const { maximized: _, ...whole } = layout
  if (target !== from.id || from.tabs.length > 1) {
    const focused = focusTab(whole, tabId)
    const root = splitNode(focused.root, target, direction, added, before)
    return moveTab(
      updateFrames({ ...focused, root }, (f) => f),
      tabId,
      added.id
    )
  }
  const sibling = siblingOf(layout.root, from.id)
  // The only tab of the only frame: closing it leaves nothing to split.
  if (!sibling) return layout
  // Wrap the whole sibling before removal can flatten it into its grandparent.
  const root = splitNode(whole.root, sibling.id, direction, insertTab(added, tab), before)
  return focusTab(
    updateFrames({ ...whole, root }, (f) => (f.id === from.id ? null : f)),
    tabId
  )
}

/** What a tab's menu does to the layout: Split, Move to the frame beside, Move to a new frame. */
export type LayoutAction =
  | { readonly type: "split"; readonly frameId: string; readonly direction: Direction }
  | { readonly type: "move"; readonly tabId: string; readonly frameId: string | undefined }
  | {
      readonly type: "moveToNewFrame"
      readonly tabId: string
      readonly direction: Direction
      readonly before?: boolean
    }

/** The action done to a layout, as the store does it (its ids aside). */
export const applyAction = (layout: Layout, action: LayoutAction, keyOf?: KeyOf): Layout => {
  switch (action.type) {
    case "split":
      return findFrame(layout, action.frameId)?.active ? splitFrame(layout, action.frameId, action.direction) : layout
    case "move":
      return action.frameId ? moveTab(layout, action.tabId, action.frameId, undefined, keyOf) : layout
    case "moveToNewFrame":
      return moveToNewFrame(layout, action.tabId, action.direction, { before: action.before ?? false })
  }
}

/** Whether two layouts look alike: the same tabs in each frame, the splits the same way. */
const sameShape = (a: Node, b: Node): boolean => {
  if (a === b) return true
  if (a.type === "frame")
    return b.type === "frame" && a.tabs.length === b.tabs.length && a.tabs.every((t, i) => t.id === b.tabs[i]!.id)
  return (
    b.type === "split" &&
    a.direction === b.direction &&
    a.children.length === b.children.length &&
    a.children.every((c, i) => sameShape(c, b.children[i]!))
  )
}

/**
 * Whether an action changes the layout, for the menus to disable it when not: "none" when it
 * can't act (the only tab of the only frame, no frame on that side), "same" when the result
 * looks as now (the left frame's only tab moved to a new frame on the left). Frame and split
 * ids and shares don't count.
 */
export const canApply = (layout: Layout, action: LayoutAction, keyOf?: KeyOf): "yes" | "none" | "same" => {
  const next = applyAction(layout, action, keyOf)
  if (next === layout) return "none"
  return sameShape(next.root, layout.root) ? "same" : "yes"
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

/**
 * Tab mode: the frames show their strips (a frame with two tabs, or a split). The sidebar's show
 * button and the side panel's toggle then leave the page headers for the strips (owner,
 * 2026-11-07; DESIGN §10.1).
 */
export const showsStrips = (layout: Layout) => isSplit(layout) || (frames(layout.root)[0]?.tabs.length ?? 0) >= 2

/**
 * The frames whose strips carry the shell's buttons in tab mode: the top-left one the hidden
 * sidebar's show button, the top-right one the side panel's toggle. A maximized frame is both.
 */
export const stripCorners = (layout: Layout): { topLeft: string; topRight: string } => {
  const shown = layout.maximized ? frames(layout.root).find((f) => f.id === layout.maximized) : undefined
  const corner = (node: Node, right: boolean): string => {
    if (node.type === "frame") return node.id
    const children = node.children
    return corner(node.direction === "row" && right ? children[children.length - 1]! : children[0]!, right)
  }
  const root = shown ?? layout.root
  return { topLeft: corner(root, false), topRight: corner(root, true) }
}

// --- Saved layouts: whatever is read is repaired into a valid layout, or dropped.

export const MAX_SAVED_TABS = 60
const MAX_DEPTH = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const appHref = (href: string) => {
  if (!href.startsWith("/")) return false
  try {
    return new URL(href, "http://tab.invalid").origin === "http://tab.invalid"
  } catch {
    return false
  }
}

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
        if (seen.has(t["id"]) || !appHref(t["href"]) || !accept(t["href"]) || count >= MAX_SAVED_TABS) continue
        seen.add(t["id"])
        count++
        const sticky = t["sticky"] === true
        tabs.push({
          id: t["id"],
          href: t["href"],
          preview: !sticky && t["preview"] === true,
          ...(sticky ? { sticky } : {})
        })
      }
      const preview = tabs.find((t) => t.preview && t.id === raw["active"]) ?? tabs.find((t) => t.preview)
      const ordered = [...tabs.filter((t) => t.sticky), ...tabs.filter((t) => !t.sticky)].map((t) =>
        t.preview && t.id !== preview?.id ? { ...t, preview: false } : t
      )
      const active = ordered.some((t) => t.id === raw["active"]) ? (raw["active"] as string) : (ordered[0]?.id ?? null)
      return { type: "frame", id: raw["id"], tabs: ordered, active }
    }
    if (
      raw["type"] === "split" &&
      typeof raw["id"] === "string" &&
      (raw["direction"] === "row" || raw["direction"] === "column")
    ) {
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
            return href === null ? [] : [{ id: t.id, href, preview: t.preview, ...(t.sticky ? { sticky: true } : {}) }]
          })
        }
      : { type: "split", id: n.id, direction: n.direction, sizes: n.sizes, children: n.children.map(node) }
  return {
    version: 1,
    root: node(layout.root),
    focused: layout.focused,
    recent: layout.recent.slice(0, MAX_SAVED_TABS)
  }
}
