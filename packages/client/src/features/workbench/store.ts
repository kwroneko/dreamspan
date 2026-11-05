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
import { itemKey, persistHref, shellKeys } from "./kinds.ts"
import {
  allTabs,
  closeFrame,
  closeTab,
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
  newId,
  type OpenOptions,
  openTab,
  pinTab,
  resizeSplit,
  restoreLayout,
  saveLayout,
  setTabHref,
  splitFrame,
  type Direction
} from "./model.ts"

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

  readonly userId: string
  private readonly browser: RouterHistory
  private readonly save: (json: string) => void

  constructor(userId: string, browser: RouterHistory, saved: unknown, save: (json: string) => void) {
    this.userId = userId
    this.browser = browser
    this.save = save
    const href = browser.location.href
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
    // A preview tab in the focused frame goes there itself, as navigating did before tabs
    // (fromTab), unless another tab has that item open.
    const elsewhere = allTabs(this.layout).some((t) => itemKey(t.href) === itemKey(href))
    if (tab.preview && !elsewhere && frameOfTab(this.layout, tabId)?.id === focusedFrame(this.layout).id) return false
    // The view navigated to that URL whole: its sidebar keys are what the sidebar shows next.
    this.shellChange = shellDiff(null, href)
    this.open(href, { state: clean(state) })
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
    // Became an item another tab has open (a replace): that tab shows it instead.
    const twin = allTabs(this.layout).find((t) => t.id !== tabId && itemKey(t.href) === key)
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

  private fromBrowser(href: string, state: HistoryState, action: Action) {
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
    const change = this.shellChange
    this.shellChange = null
    if (keys.size === 0) return href
    const url = new URL(href, "http://tab.invalid")
    const current = new URL(this.browser.location.href, "http://tab.invalid")
    for (const key of keys) url.searchParams.delete(key)
    for (const key of keys) {
      const value = change?.has(key) ? change.get(key) : current.searchParams.get(key)
      if (value !== null && value !== undefined) url.searchParams.set(key, value)
    }
    const search = url.searchParams.toString()
    return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
  }

  // --- What the user does.

  /** Opens an item (model.ts `openTab`), at its URL's history state. */
  open(href: string, options: OpenOptions & { state?: HistoryState; mirror?: Action } = {}) {
    const { state, mirror = "PUSH", ...rest } = options
    const next = openTab(this.layout, href, itemKey, { ...rest, id: rest.id ?? newId("t") })
    const opened = allTabs(next).find((t) => itemKey(t.href) === itemKey(href))!
    // A tab already mounted (the item's own, or the preview taking it) navigates in place.
    if (findTab(this.layout, opened.id)) this.apply(opened.id, href, state ?? {}, "PUSH")
    else {
      if (state && Object.keys(state).length > 0) this.initialState.set(opened.id, state)
      // Back inside the new tab (an Import page's own Back) returns to where it was opened.
      const from = focusedTab(this.layout)
      const fromHref = from && (this.histories.get(from.id)?.location.href ?? from.href)
      if (fromHref && itemKey(fromHref) !== itemKey(href)) this.openedFrom.set(opened.id, fromHref)
    }
    // Opening pushes a place in the browser's history, so Back returns to what was shown.
    this.set(next, mirror)
    return opened.id
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
  /** The tab with this item, kept open (a double click where it was opened). */
  pinItem(href: string) {
    const key = itemKey(href)
    const tab = allTabs(this.layout).find((t) => itemKey(t.href) === key)
    if (tab) this.pin(tab.id)
  }
  close(tabId: string) {
    this.set(closeTab(this.layout, tabId))
  }
  closeOthers(tabId: string) {
    const frame = frameOfTab(this.layout, tabId)
    if (!frame) return
    let next = this.layout
    for (const t of frame.tabs) if (t.id !== tabId) next = closeTab(next, t.id)
    this.set(focusTab(next, tabId))
  }
  closeFrame(frameId: string) {
    this.set(closeFrame(this.layout, frameId))
  }
  split(frameId: string, direction: Direction) {
    this.set(splitFrame(this.layout, frameId, direction))
  }
  move(tabId: string, frameId: string, index?: number) {
    this.set(moveTab(this.layout, tabId, frameId, index))
  }
  /** Moves a tab into a new frame beside its own. */
  moveToSplit(tabId: string, direction: Direction) {
    const frame = frameOfTab(this.layout, tabId)
    if (!frame) return
    const id = newId("f")
    let next = splitFrame(focusTab(this.layout, tabId), frame.id, direction, id)
    if (!findTab(next, tabId) || frameOfTab(next, tabId)?.id !== id) next = moveTab(next, tabId, id)
    this.set(next)
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
    // The shown tab focused last that is a chat, or an editor opened from a chat (its
    // `?chat=`): that chat's panel. A library page shown on its own has none, as before tabs.
    for (const id of this.layout.recent) {
      const tab = findTab(this.layout, id)
      if (!tab || frameOfTab(this.layout, id)?.active !== id) continue
      if (this.panelTabs.has(id)) return id
      const chat = new URL(tab.href, "http://tab.invalid").searchParams.get("chat")
      if (!chat) continue
      const key = itemKey(`/chats/${chat}`)
      const owner = allTabs(this.layout).find((t) => this.panelTabs.has(t.id) && itemKey(t.href) === key)
      if (owner) return owner.id
    }
    return null
  }

  frames() {
    return frames(this.layout.root)
  }
}
