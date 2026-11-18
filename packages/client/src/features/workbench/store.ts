// The center column's state for one signed-in user: the layout (model.ts), each tab's own
// history, and the browser's URL kept on the focused tab (owner, 2026-11-05: links, Back and
// Forward and new browser tabs keep working).
//
// Every tab has an in-memory history its own router reads. A navigation inside a tab to the
// same item stays in it; to another item it opens that item (as a link would) unless it
// replaces (a chat being saved becomes its chat). While a tab is focused, its navigations are
// copied to the browser's history, and the browser's (the sidebar's links, Back, Forward)
// come back into the workbench: the focused tab's own item navigates it, another opens.
import type { RouterHistory } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { DropZone } from "./dropOpen.ts"
import { itemKey, persistHref, shellKeys } from "./kinds.ts"
import {
  allTabs,
  closeFrame,
  closeTab,
  closeTabs,
  type CloseWhich,
  maximizeFrame,
  stickTab,
  findTab,
  focusFrame,
  focusTab,
  focusedFrame,
  focusedTab,
  frameOfTab,
  frames,
  initialLayout,
  type Layout,
  moveTab,
  neighbours,
  newId,
  type OpenOptions,
  openTab,
  openTabAt,
  pinTab,
  resizeSplit,
  restoreLayout,
  saveLayout,
  setTabHref,
  splitFrame,
  type Direction
} from "./model.ts"
import { layoutKeys, withoutLayoutParams } from "../../tabLayoutParams.ts"

export type HistoryState = Record<string, unknown>
type Action = "PUSH" | "REPLACE"

/** The history keys of TanStack's own, never copied between histories. */
const clean = (state: unknown): HistoryState => {
  if (typeof state !== "object" || state === null) return {}
  const { __TSR_index: _i, __TSR_key: _k, key: _key, ...rest } = state as Record<string, unknown>
  return rest
}

/** What a tab's view says about itself (`useTitle`, a chat's faces). */
export interface TabMeta {
  readonly title?: string
  readonly decoration?: { readonly key: string; readonly node: ReactNode }
  /** What the tab holds, as a named region (an editor: "Preset editor"). */
  readonly region?: string
}

const HOME = "/"

/**
 * The sidebar's keys (`shellSearchKeys`) that differ from `before` in `after`, with their new
 * values (null: cleared); with no `before`, all of them as `after` has them.
 */
const shellDiff = (before: string | null, after: string) => {
  const was = before === null ? null : new URL(before, "http://tab.invalid").searchParams
  const now = new URL(after, "http://tab.invalid").searchParams
  const change = new Map<string, string | null>()
  for (const key of shellKeys()) {
    const value = now.get(key)
    if (was === null || was.get(key) !== value) change.set(key, value)
  }
  return change
}

/**
 * The sidebar's place a link carries when it opens beside or as a bare link: the params it
 * names, the rest as the sidebar has them; a link naming the scope (`character`, `forks`,
 * `side`) sets it whole, as the openers that scope it do (`sidebarCleared`).
 */
const SCOPE = ["character", "forks", "side"]
const shellCarried = (href: string) => {
  const now = new URL(href, "http://tab.invalid").searchParams
  const change = new Map<string, string | null>()
  for (const key of shellKeys()) if (now.has(key)) change.set(key, now.get(key))
  if (SCOPE.some((key) => change.has(key))) for (const key of SCOPE) if (!change.has(key)) change.set(key, null)
  return change
}

export class WorkbenchStore {
  layout: Layout
  private readonly listeners = new Set<() => void>()
  private readonly histories = new Map<string, RouterHistory>()
  /** Where a tab not yet mounted starts: its URL's history state. */
  private readonly initialState = new Map<string, HistoryState>()
  /** Where a new tab was opened from: its history's entry before its own, so Back returns. */
  private readonly openedFrom = new Map<string, string>()
  private readonly meta = new Map<string, { readonly item: string; readonly meta: TabMeta }>()
  private readonly metaListeners = new Set<() => void>()
  /** Tabs whose views show the side panel (chats), most recent decides who shows it. */
  private readonly panelTabs = new Set<string>()
  /** The sidebar's keys a tab's own navigation set or cleared, for the next mirror. */
  private shellChange: ReadonlyMap<string, string | null> | null = null
  private mirroring = false
  private applying = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  /** Tabs closed in this page, the last first, for Reopen closed tab (at most 20). */
  private closed: Array<{ readonly href: string; readonly frameId: string | undefined }> = []
  /** Tabs whose views have changes not yet saved (`UnsavedTracker`), for the tab's dot. */
  private readonly unsavedTabs = new Set<string>()

  readonly userId: string
  private readonly browser: RouterHistory
  private readonly save: (json: string) => void

  constructor(userId: string, browser: RouterHistory, saved: unknown, save: (json: string) => void) {
    this.userId = userId
    this.browser = browser
    this.save = save
    // The browser tab's layout params stay on the browser's URL (tabLayoutParams.ts).
    const href = withoutLayoutParams(browser.location.href)
    const restored = restoreLayout(saved)
    this.layout = restored ? openTab(restored, href, itemKey) : initialLayout(href)
    const tab = focusedTab(this.layout)
    if (tab) this.initialState.set(tab.id, clean(browser.location.state))
  }

  /** Follows the browser's history; the returned function stops. */
  start() {
    this.unsubscribe = this.browser.subscribe(({ location, action }) => {
      if (this.mirroring) return
      this.fromBrowser(location.href, clean(location.state), action.type === "PUSH" ? "PUSH" : "REPLACE")
    })
    // The focused tab's URL, as its view settled it: the browser shows the same.
    this.mirror("REPLACE")
    // A fresh URL may have discarded this tab's previous frames without another change.
    // Keep the initial layout too, so a reload cannot bring those old frames back.
    this.flush()
    const leave = () => {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.flush()
      }
    }
    window.addEventListener("pagehide", leave)
    return () => {
      window.removeEventListener("pagehide", leave)
      this.unsubscribe?.()
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.flush()
      }
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  snapshot = () => this.layout

  private set(next: Layout, action: Action = "REPLACE", saveAfter = 0) {
    if (next === this.layout) return
    const before = focusedTab(this.layout)
    this.layout = next
    // Closing the last tab leaves Home, so the column and the URL always show something.
    if (allTabs(next).length === 0) {
      this.layout = openTab(next, HOME, itemKey)
    }
    // Closed views must not keep their pictures, reading state or deferred navigation alive.
    const live = new Set(allTabs(this.layout).map((tab) => tab.id))
    for (const values of [this.meta, this.initialState, this.openedFrom, this.unsavedTabs]) {
      for (const id of values.keys()) if (!live.has(id)) values.delete(id)
    }
    for (const listener of this.listeners) listener()
    this.schedule(saveAfter)
    const after = focusedTab(this.layout)
    if (after && (after.id !== before?.id || after.href !== before?.href)) this.mirror(action)
  }

  /**
   * Saves the layout: at once for what the user did (a reload right after keeps it), a moment
   * later for a stream of changes (a divider dragged, a view settling its URL).
   */
  private schedule(after = 400) {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), after)
  }
  private flush() {
    this.saveTimer = null
    this.save(JSON.stringify(saveLayout(this.layout, persistHref)))
  }

  // --- Each tab's history.

  /** A tab's router mounted with this history; the returned function forgets it. */
  attach(tabId: string, history: RouterHistory) {
    this.histories.set(tabId, history)
    const state = this.initialState.get(tabId)
    this.initialState.delete(tabId)
    const tab = findTab(this.layout, tabId)
    if (tab && (state || tab.href !== history.location.href)) this.apply(tabId, tab.href, state ?? {}, "REPLACE")
    const unsubscribe = history.subscribe(({ location, action }) => {
      if (this.applying) return
      this.fromTab(tabId, location.href, action.type === "PUSH" ? "PUSH" : "REPLACE")
    })
    return () => {
      unsubscribe()
      if (this.histories.get(tabId) === history) this.histories.delete(tabId)
    }
  }

  /** The entry before a new tab's own in its history: where it was opened from. */
  takeOpenedFrom(tabId: string) {
    const from = this.openedFrom.get(tabId)
    this.openedFrom.delete(tabId)
    return from
  }

  /** Whether a navigation inside a tab leaves for another item: it opens there instead. */
  leaves(tabId: string, href: string, state: unknown, action: string) {
    if (this.applying) return false
    const tab = findTab(this.layout, tabId)
    if (!tab || action !== "PUSH" || itemKey(href) === itemKey(tab.href)) return false
    // A link in a tab opens in that tab's frame, never in another (VS Code opens in the group
    // clicked in): another frame showing the item keeps its place and scroll.
    const frame = frameOfTab(this.layout, tabId)
    if (!frame) return false
    // A preview tab goes there itself, as navigating did before tabs (fromTab), unless another
    // tab of its frame has that item open.
    const twin = frame.tabs.some((t) => itemKey(t.href) === itemKey(href))
    if (tab.preview && !twin) return false
    // The view navigated to that URL whole: its sidebar keys are what the sidebar shows next.
    this.shellChange = shellDiff(null, href)
    this.open(href, { state: clean(state), frame: frame.id })
    this.shellChange = null
    return true
  }

  private apply(tabId: string, href: string, state: HistoryState, action: Action) {
    const history = this.histories.get(tabId)
    if (!history) {
      this.initialState.set(tabId, state)
      return
    }
    this.applying = true
    try {
      if (action === "PUSH") history.push(href, state, { ignoreBlocker: true })
      else history.replace(href, state, { ignoreBlocker: true })
    } finally {
      this.applying = false
    }
  }

  private fromTab(tabId: string, href: string, action: Action) {
    const key = itemKey(href)
    // Became an item another tab of its frame has open (a replace): that tab shows it instead.
    const twin = frameOfTab(this.layout, tabId)?.tabs.find((t) => t.id !== tabId && itemKey(t.href) === key)
    if (twin) {
      const next = focusTab(setTabHref(closeTab(this.layout, tabId), twin.id, href), twin.id)
      this.apply(twin.id, href, {}, "REPLACE")
      this.set(next)
      return
    }
    const focused = focusedTab(this.layout)?.id === tabId
    const before = this.layout
    // A tab's view changing the sidebar's keys (Chats with Mira) changes the sidebar.
    if (focused) this.shellChange = shellDiff(findTab(before, tabId)?.href ?? null, href)
    this.layout = setTabHref(this.layout, tabId, href)
    if (before !== this.layout) {
      for (const listener of this.listeners) listener()
      this.schedule()
    }
    if (focused) this.mirror(action)
  }

  private fromBrowser(browserHref: string, state: HistoryState, action: Action) {
    const href = withoutLayoutParams(browserHref)
    const focused = focusedTab(this.layout)
    if (focused && itemKey(focused.href) === itemKey(href)) {
      // The tab first, so the browser's URL (Back's place) isn't copied back over it.
      this.apply(focused.id, href, state, action)
      this.set(setTabHref(this.layout, focused.id, href))
      return
    }
    // The browser has its entry already: the URL is corrected in place, not pushed again.
    this.open(href, { state, mirror: "REPLACE" })
  }

  /** The browser's URL: the focused tab's, with the sidebar's place as the browser has it. */
  private mirror(action: Action) {
    const tab = focusedTab(this.layout)
    if (!tab) return
    const history = this.histories.get(tab.id)
    const location = history?.location
    const href = this.withShellParams(location?.href ?? tab.href)
    let state = clean(location?.state)
    if (href === this.browser.location.href) {
      // The same place: only what the view keeps in its history state (a chat's reading place).
      const browserState = clean(this.browser.location.state)
      const same = (key: string, value: unknown) => JSON.stringify(browserState[key]) === JSON.stringify(value)
      if (Object.entries(state).every(([key, value]) => same(key, value))) return
      state = { ...browserState, ...state }
      action = "REPLACE"
    }
    this.mirroring = true
    try {
      if (action === "PUSH") this.browser.push(href, state, { ignoreBlocker: true })
      else this.browser.replace(href, state, { ignoreBlocker: true })
    } finally {
      this.mirroring = false
    }
  }

  private withShellParams(href: string) {
    const keys = shellKeys()
    const layout = layoutKeys()
    const change = this.shellChange
    this.shellChange = null
    if (keys.size === 0 && layout.size === 0) return href
    const url = new URL(href, "http://tab.invalid")
    const current = new URL(this.browser.location.href, "http://tab.invalid")
    for (const key of [...keys, ...layout]) url.searchParams.delete(key)
    for (const key of keys) {
      const value = change?.has(key) ? change.get(key) : current.searchParams.get(key)
      if (value !== null && value !== undefined) url.searchParams.set(key, value)
    }
    // The layout is the browser tab's: only the browser's URL sets it (tabLayoutParams.ts).
    for (const key of layout) {
      const value = current.searchParams.get(key)
      if (value !== null) url.searchParams.set(key, value)
    }
    const search = url.searchParams.toString()
    return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
  }

  // --- What the user does.

  /** Opens an item (model.ts `openTab`), at its URL's history state. */
  open(link: string, options: OpenOptions & { state?: HistoryState; mirror?: Action } = {}) {
    const href = withoutLayoutParams(link)
    const { state, mirror = "PUSH", ...rest } = options
    const { layout: next, tabId } = openTabAt(this.layout, href, itemKey, { ...rest, id: rest.id ?? newId("t") })
    // A tab already mounted (the item's own, or the preview taking it) navigates in place.
    if (findTab(this.layout, tabId)) this.apply(tabId, href, state ?? {}, "PUSH")
    else {
      if (state && Object.keys(state).length > 0) this.initialState.set(tabId, state)
      // Back inside the new tab (an Import page's own Back) returns to where it was opened.
      const from = focusedTab(this.layout)
      const fromHref = from && (this.histories.get(from.id)?.location.href ?? from.href)
      if (fromHref && itemKey(fromHref) !== itemKey(href)) this.openedFrom.set(tabId, fromHref)
    }
    // Opening pushes a place in the browser's history, so Back returns to what was shown.
    this.set(next, mirror)
    return tabId
  }

  focusTab(tabId: string) {
    this.set(focusTab(this.layout, tabId))
  }
  focusFrame(frameId: string) {
    this.set(focusFrame(this.layout, frameId))
  }
  pin(tabId: string) {
    this.set(pinTab(this.layout, tabId))
  }
  /** The tab with this item, kept open (a double click where it was opened): the focused one's. */
  pinItem(href: string) {
    const key = itemKey(href)
    const focused = focusedTab(this.layout)
    const tab =
      focused && itemKey(focused.href) === key ? focused : allTabs(this.layout).find((t) => itemKey(t.href) === key)
    if (tab) this.pin(tab.id)
  }
  close(tabId: string) {
    this.closing(closeTab(this.layout, tabId))
  }
  closeOthers(tabId: string) {
    this.closeTabs(tabId, "others")
  }
  /** Close others, to the right, all, or saved, in the tab's frame; pinned tabs stay. */
  closeTabs(tabId: string, which: CloseWhich) {
    this.closing(closeTabs(this.layout, tabId, which, (id) => this.unsavedTabs.has(id)))
  }
  closeFrame(frameId: string) {
    this.closing(closeFrame(this.layout, frameId))
  }
  /** Sets a layout that closed tabs, remembering them for Reopen closed tab. */
  private closing(next: Layout) {
    const kept = new Set(allTabs(next).map((t) => t.id))
    const gone = frames(this.layout.root).flatMap((f) =>
      f.tabs.filter((t) => !kept.has(t.id)).map((t) => ({ href: t.href, frameId: f.id }))
    )
    this.closed = [...gone.reverse(), ...this.closed].slice(0, 20)
    this.set(next)
  }
  get canReopen() {
    return this.closed.length > 0
  }
  /** Opens the tab closed last again, in its frame if that's still there (kept). */
  reopenClosed() {
    const [last, ...rest] = this.closed
    if (!last) return
    this.closed = rest
    const frame = this.frames().some((f) => f.id === last.frameId) ? last.frameId : undefined
    this.open(last.href, { preview: false, ...(frame ? { frame } : {}) })
  }
  stick(tabId: string, sticky: boolean) {
    this.set(stickTab(this.layout, tabId, sticky))
  }
  /** Shows a frame alone, or every frame again (`null`). */
  maximize(frameId: string | null) {
    this.set(maximizeFrame(this.layout, frameId))
  }
  setUnsaved(tabId: string, unsaved: boolean) {
    if (this.unsavedTabs.has(tabId) === unsaved) return
    if (unsaved) this.unsavedTabs.add(tabId)
    else this.unsavedTabs.delete(tabId)
    for (const listener of this.metaListeners) listener()
  }
  isUnsaved = (tabId: string) => this.unsavedTabs.has(tabId)
  /** Splits a frame; the new frame shows the shown tab's item too, at the same place. */
  split(frameId: string, direction: Direction) {
    const frame = this.frames().find((f) => f.id === frameId)
    const shown = frame?.active ? this.histories.get(frame.active) : undefined
    const copyId = newId("t")
    if (shown) this.initialState.set(copyId, clean(shown.location.state))
    this.set(splitFrame(this.layout, frameId, direction, { copyId }))
  }
  move(tabId: string, frameId: string, index?: number) {
    this.set(moveTab(this.layout, tabId, frameId, index, itemKey))
  }
  /**
   * Opens an item from inside a frame (a link in one of its tabs): in that frame, never another,
   * so a frame showing the same item elsewhere keeps its place. Unknown frames open as `open`.
   */
  openIn(frameId: string | undefined, href: string, options: OpenOptions & { whole?: boolean } = {}) {
    const { whole = false, ...rest } = options
    const frame = frames(this.layout.root).find((f) => f.id === frameId)?.id
    // `whole`: a link followed as a whole URL, its sidebar place included.
    if (whole) this.shellChange = shellCarried(href)
    try {
      return this.open(href, { ...rest, ...(frame ? { frame } : {}) })
    } finally {
      this.shellChange = null
    }
  }
  /** The frame a tab is in. */
  frameOf(tabId: string) {
    return frameOfTab(this.layout, tabId)?.id
  }
  /**
   * Opens an item to the side (VS Code's Open to the Side): in the frame on the right of the
   * focused one, else in a new frame there. Kept, as a deliberate open.
   */
  openBeside(href: string) {
    const focused = focusedFrame(this.layout)
    let frame = neighbours(this.layout, focused.id).right
    if (!frame) {
      frame = newId("f")
      this.layout = splitFrame(this.layout, focused.id, "row", { newFrameId: frame, empty: true })
    }
    // The link's sidebar place comes with it, as a click on it would bring it (a character's
    // tile scopes the sidebar to the character's chats).
    this.shellChange = shellCarried(href)
    try {
      return this.open(href, { frame, preview: false })
    } finally {
      this.shellChange = null
    }
  }
  /**
   * Opens an item beside a frame, never in it (a workshop popped out of a story's side panel):
   * focuses the item's tab if one is open anywhere; else opens it as a kept tab in a neighbouring
   * frame (the right one first), splitting the frame when it's alone. The frame's tabs stay.
   */
  openBesideOf(frameId: string | undefined, href: string) {
    const key = itemKey(href)
    const existing = allTabs(this.layout).find((t) => itemKey(t.href) === key)
    if (existing) {
      this.focusTab(existing.id)
      return existing.id
    }
    const from = (frameId && this.frames().find((f) => f.id === frameId)?.id) || focusedFrame(this.layout).id
    const near = neighbours(this.layout, from)
    let frame = near.right ?? near.left ?? near.down ?? near.up ?? this.frames().find((f) => f.id !== from)?.id
    if (!frame) {
      frame = newId("f")
      this.layout = splitFrame(this.layout, from, "row", { newFrameId: frame, empty: true })
    }
    // Beside what that frame shows, never in place of its preview tab (as `dropOpen`).
    const preview = this.frames()
      .find((f) => f.id === frame)
      ?.tabs.find((t) => t.preview)
    if (preview) this.layout = pinTab(this.layout, preview.id)
    return this.open(href, { frame, preview: false })
  }
  /**
   * Moves a tab into a new frame beside a frame (its own by default): `before` puts it on the
   * left or above, as a tab dropped on that edge does.
   */
  moveToSplit(tabId: string, direction: Direction, frameId?: string, before = false) {
    const frame = frameId ? this.frames().find((f) => f.id === frameId) : frameOfTab(this.layout, tabId)
    if (!frame) return
    const id = newId("f")
    const next = splitFrame(focusTab(this.layout, tabId), frame.id, direction, { newFrameId: id, before, empty: true })
    this.set(moveTab(next, tabId, id, undefined, itemKey))
  }
  /**
   * Opens an item dropped on a frame (a picture dragged from the portrait column), kept: into
   * the frame beside its tabs (its preview tab is kept too), at `index` in its strip when
   * dropped there, or into a new frame on that side.
   */
  dropOpen(href: string, frameId: string, zone: DropZone, index?: number) {
    const frame = this.frames().find((f) => f.id === frameId)
    if (!frame) return
    if (zone === "center") {
      // Put beside what the frame shows, never in place of its preview tab.
      const preview = frame.tabs.find((t) => t.preview)
      if (preview) this.layout = pinTab(this.layout, preview.id)
      const tabId = this.open(href, { frame: frameId, preview: false })
      if (index !== undefined) {
        // The drop names a boundary before opening added the tab. Follow the tab on its
        // right, whose index may have shifted, so moving uses the current strip's boundary.
        const before = frame.tabs[index]
        const tabs = frameOfTab(this.layout, tabId)!.tabs
        this.move(tabId, frameId, before ? tabs.findIndex((t) => t.id === before.id) : tabs.length)
      }
      return
    }
    const id = newId("f")
    this.layout = splitFrame(this.layout, frameId, zone === "left" || zone === "right" ? "row" : "column", {
      newFrameId: id,
      before: zone === "left" || zone === "top",
      empty: true
    })
    this.open(href, { frame: id, preview: false })
  }
  resize(splitId: string, sizes: ReadonlyArray<number>) {
    this.set(resizeSplit(this.layout, splitId, sizes), "REPLACE", 400)
  }

  // --- What views say about themselves.

  setMeta(tabId: string, meta: TabMeta) {
    // What a view said is about the item it showed: a tab that took another item starts over.
    const tab = findTab(this.layout, tabId)
    if (!tab) return
    const item = itemKey(tab.href)
    const stored = this.meta.get(tabId)
    const before = stored?.item === item ? stored.meta : undefined
    if (
      before &&
      (meta.title === undefined || before.title === meta.title) &&
      (meta.decoration === undefined || before.decoration?.key === meta.decoration.key) &&
      (meta.region === undefined || before.region === meta.region)
    )
      return
    this.meta.set(tabId, { item, meta: { ...before, ...meta } })
    for (const listener of this.metaListeners) listener()
  }
  /** What the tab's view says about the item it shows now. */
  metaOf = (tabId: string) => {
    const stored = this.meta.get(tabId)
    const tab = findTab(this.layout, tabId)
    return stored && tab && stored.item === itemKey(tab.href) ? stored.meta : undefined
  }
  subscribeMeta = (listener: () => void) => {
    this.metaListeners.add(listener)
    return () => void this.metaListeners.delete(listener)
  }

  /** A view that shows the side panel while mounted; the returned function stops. */
  addPanelTab(tabId: string) {
    this.panelTabs.add(tabId)
    for (const listener of this.listeners) listener()
    return () => {
      this.panelTabs.delete(tabId)
      for (const listener of this.listeners) listener()
    }
  }
  /**
   * The tab whose side panel shows (owner direction, 2026-11-05: the panels follow the frame
   * last focused): the chat focused last among those shown, or the chat an editor shown was
   * opened from; on a phone only the tab shown has one.
   */
  panelOwner(wide: boolean) {
    if (!wide) {
      const tab = focusedTab(this.layout)
      return tab && this.panelTabs.has(tab.id) ? tab.id : null
    }
    // The tab focused last that is a chat, or an editor opened from a chat (its `?chat=`): that
    // chat's panel, even once another tab shows over it in its frame (owner, 2026-11-07: "Why
    // can't it remain attached to the chat it was on before?"). Pictures, library pages, Home
    // and other tabs never take it; it hides only when no chat is open.
    for (const id of this.layout.recent) {
      const tab = findTab(this.layout, id)
      if (!tab) continue
      if (this.panelTabs.has(id)) return id
      const params = new URL(tab.href, "http://tab.invalid").searchParams
      const chat = params.get("chat")
      if (!chat) continue
      const key = itemKey(`/chats/${chat}`)
      const sourceId = params.get("chatTab")
      const source = sourceId ? findTab(this.layout, sourceId) : undefined
      if (source && this.panelTabs.has(source.id) && itemKey(source.href) === key) return source.id
      const owner = allTabs(this.layout).find((t) => this.panelTabs.has(t.id) && itemKey(t.href) === key)
      if (owner) return owner.id
    }
    return null
  }

  frames() {
    return frames(this.layout.root)
  }
}
