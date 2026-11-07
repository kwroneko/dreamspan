// What a view inside a workbench tab asks about its tab: whether it's focused or shown, the
// side panel's place, and how to name the tab. Outside a workbench (tests, a feature that
// replaced it) every answer is the single-view one: focused, shown, the panel inline.
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react"
import { type DropTarget, dropTargetAt } from "./dropOpen.ts"
import { itemKey } from "./kinds.ts"
import { findTab, focusedFrame, focusedTab, frameOfTab, leftEdgeFrames } from "./model.ts"
import type { WorkbenchStore } from "./store.ts"

export interface TabContextValue {
  readonly tabId: string
  readonly store: WorkbenchStore
}

export const TabContext = createContext<TabContextValue | null>(null)

export const WorkbenchContext = createContext<{
  readonly store: WorkbenchStore
  /** Where the focused chat's side panel goes, beside the frames. */
  readonly sideHost: HTMLElement | null
  /** Where the portrait column goes, left of the frames. */
  readonly portraitHost: HTMLElement | null
} | null>(null)

const noop = () => () => {}

export const useWorkbenchTab = () => useContext(TabContext)

/** The workbench, from anywhere in the shell (the sidebar's links double-clicked, say). */
export const useWorkbench = () => useContext(WorkbenchContext)?.store ?? null

/** The browser's URL is this tab's: its keys, title and commands are the page's. */
export function useTabFocused() {
  const tab = useContext(TabContext)
  return useSyncExternalStore(tab?.store.subscribe ?? noop, () =>
    tab ? focusedTab(tab.store.layout)?.id === tab.tabId : true
  )
}

/** In a frame along the column's left edge (where the hidden sidebar's button goes). */
export function useTabAtLeftEdge() {
  const tab = useContext(TabContext)
  return useSyncExternalStore(tab?.store.subscribe ?? noop, () => {
    if (!tab) return true
    const frame = frameOfTab(tab.store.layout, tab.tabId)
    return !frame || leftEdgeFrames(tab.store.layout.root).has(frame.id)
  })
}

/** On screen: the shown tab of its frame (on a phone, of the focused frame only). */
export function useTabShown(wide: boolean) {
  const tab = useContext(TabContext)
  return useSyncExternalStore(tab?.store.subscribe ?? noop, () => {
    if (!tab) return true
    const layout = tab.store.layout
    const frame = frameOfTab(layout, tab.tabId)
    if (!frame || frame.active !== tab.tabId) return false
    if (wide && layout.maximized && layout.maximized !== frame.id) return false
    return wide || focusedFrame(layout).id === frame.id
  })
}

/**
 * The side panel's place for a view that has one (a chat): `inline` beside it outside a
 * workbench, else the shell's column while this tab owns the panel, else nowhere.
 */
export function useSidePanelPlace(wide: boolean): { show: boolean; host: HTMLElement | null } {
  const tab = useContext(TabContext)
  const workbench = useContext(WorkbenchContext)
  useEffect(() => (tab ? tab.store.addPanelTab(tab.tabId) : undefined), [tab])
  const owner = useSyncExternalStore(tab?.store.subscribe ?? noop, () =>
    tab ? tab.store.panelOwner(wide) === tab.tabId : true
  )
  if (!tab) return { show: true, host: null }
  return { show: owner, host: wide ? (workbench?.sideHost ?? null) : null }
}

/**
 * The portrait column's place for a view with pictures `open`: beside it outside a workbench,
 * else the shell's column left of the frames while this tab's pictures are the ones it shows
 * (`portraitOwner`), else nowhere. On a phone the viewer is full screen, so this isn't asked.
 */
export function usePortraitColumnPlace(open: boolean): { show: boolean; host: HTMLElement | null } {
  const tab = useContext(TabContext)
  const workbench = useContext(WorkbenchContext)
  useEffect(() => (tab && open ? tab.store.addPortraitTab(tab.tabId) : undefined), [tab, open])
  const owner = useSyncExternalStore(tab?.store.subscribe ?? noop, () =>
    tab ? tab.store.portraitOwner() === tab.tabId : true
  )
  if (!tab) return { show: open, host: null }
  const host = workbench?.portraitHost ?? null
  return { show: open && owner && host !== null, host }
}

/**
 * Opening something as a tab from outside the strips (a picture from the portrait column): what
 * a point over the frames would take, a drop there, and an open beside the view's own tab, kept.
 * Null outside a workbench.
 */
export function useOpenAsTab() {
  const tab = useContext(TabContext)
  if (!tab) return null
  const { store, tabId } = tab
  return {
    at: dropTargetAt,
    drop: (target: DropTarget, href: string) => store.dropOpen(href, target.frameId, target.zone, target.index),
    open: (href: string) => store.dropOpen(href, store.frameOf(tabId) ?? store.frames()[0]!.id, "center")
  }
}

/** The item the tab shows now: what it says about itself is said again when this changes. */
function useTabItem(tab: TabContextValue | null) {
  return useSyncExternalStore(tab?.store.subscribe ?? noop, () => {
    const href = tab ? findTab(tab.store.layout, tab.tabId)?.href : undefined
    return href === undefined ? null : itemKey(href)
  })
}

/**
 * Names the tab: its strip shows the title, and a picture where the view gives one (`key`
 * says when the picture changed).
 */
export function useTabMeta(title: string | undefined, decoration?: { key: string; node: ReactNode }) {
  const tab = useContext(TabContext)
  const key = decoration?.key
  const node = decoration?.node
  const item = useTabItem(tab)
  useEffect(() => {
    if (!tab) return
    tab.store.setMeta(tab.tabId, {
      ...(title !== undefined ? { title } : {}),
      ...(key !== undefined ? { decoration: { key, node } } : {})
    })
    // The picture is described by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, item, title, key])
}

/**
 * Names what the tab holds as a region (an editor: "Preset editor"), its header included; true
 * inside a tab. Outside one the view names its own region.
 */
export function useTabRegion(label: string) {
  const tab = useContext(TabContext)
  const item = useTabItem(tab)
  useEffect(() => {
    if (tab) tab.store.setMeta(tab.tabId, { region: label })
  }, [tab, item, label])
  return tab !== null
}
