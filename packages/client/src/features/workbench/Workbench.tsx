// The center column as frames of tabs (owner, 2026-11-05; DESIGN §10.1): VS Code's split view
// with tabs. One item and no split looks as the single view did; the strip appears once a
// frame has two tabs or the column is split. The side panel stays beside the frames and shows
// the chat focused last (tab.tsx `useSidePanelPlace`); the portrait column stays left of the
// frames, one for all of them (`usePortraitHost`). The side panel coming or going takes its
// width from the frames beside it only (`useKeepDividers`), so no other divider moves.
//
// Each tab renders its own router (TabHost) into an element of its own, which is put in its
// frame while shown and taken out of the page while not: its state, scroll and drafts stay,
// and nothing hidden is left in the page to find or to focus.
import { createMemoryHistory, RouterProvider, useRouter } from "@tanstack/react-router"
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { createPortal } from "react-dom"
import { buildRouter } from "../../routes.tsx"
import { useSession } from "../../session.ts"
import { Away } from "../../ui/away.ts"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { UnsavedScope, UnsavedTracker } from "../../ui/UnsavedChanges.tsx"
import { Tooltip, IconButton, iconButtonClass } from "../../ui/Tooltip.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { CenterPage, sidebarToggle } from "../shell.tsx"
import { PanelPlaceholder } from "../chat/PanelPlaceholder.tsx"
import { defaultTitle, itemKey, tabKind } from "./kinds.ts"
import {
  allTabs,
  type Frame,
  focusedFrame,
  frameOfTab,
  frames,
  canApply,
  isSplit,
  type Layout,
  type LayoutAction,
  stripCorners,
  neighbours,
  type Node,
  type Split,
  type Tab,
  type Direction
} from "./model.ts"
import { type DropZone, dropZone } from "./dropOpen.ts"
import { dragPayloadOf, isAppDrag } from "../../ui/appDrags.ts"
import { OPEN_BESIDE } from "./OpenBeside.tsx"
import { WorkbenchStore } from "./store.ts"
import { decodeLayout, encodeLayout, WORKBENCH_PARAM } from "./layoutParam.ts"
import { persistHref } from "./kinds.ts"
import { readLayoutParam, withoutLayoutParams, writeLayoutParam } from "../../tabLayoutParams.ts"
import { TabContext, useTabShown, useWorkbenchTab, WorkbenchContext } from "./tab.tsx"

const TAB_MIME = "application/x-rp-workbench-tab"

/** A drag a frame takes: a tab, or something of the app's that opens as one (ui/appDrags.ts). */
const opensHere = (dataTransfer: DataTransfer | null) =>
  (dataTransfer?.types.includes(TAB_MIME) ?? false) || dragPayloadOf(dataTransfer) !== null

/**
 * Something else of the app's dragged over a frame (a link, a message's image): the frame
 * doesn't take it, and the browser doesn't open it either, so its drop does nothing. Text
 * fields and editors take their own drops; so does whatever handled it already.
 */
const refuseOther = (event: DragEvent | React.DragEvent) => {
  if (event.defaultPrevented || !isAppDrag(event.dataTransfer) || opensHere(event.dataTransfer)) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest("input, textarea, [contenteditable]:not([contenteditable=false])")) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
}
const MIN_WIDTH = 320
const MIN_HEIGHT = 160

const WIDE = "(min-width: 1024px)"
const subscribeWide = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const useWideScreen = () => useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches)

/** Sets where the side panel's toggle goes: the top-right strip's end (tab.tsx `usePanelTogglePlace`). */
const PanelToggleHostRef = createContext<(element: HTMLElement | null) => void>(() => {})

/** Save the live layout into the browser tab's URL. */
const saveToUrl = (layout: Layout) =>
  writeLayoutParam(WORKBENCH_PARAM, encodeLayout(layout, persistHref, withoutLayoutParams))

/** Registered in the shell's center column (`centerColumn`). */
export function Workbench() {
  const userId = useSession().user.id
  return <WorkbenchFor key={userId} userId={userId} />
}

/**
 * This browser tab's frames, from its URL (`layoutParam.ts`): a reload, a copied link or a
 * duplicated tab opens them again; a URL without them opens its page alone.
 */
function WorkbenchFor({ userId }: { userId: string }) {
  const router = useRouter()
  const [store] = useState(
    () =>
      new WorkbenchStore(
        userId,
        router.history,
        decodeLayout(readLayoutParam(WORKBENCH_PARAM), withoutLayoutParams(router.history.location.href)),
        saveToUrl
      )
  )
  useEffect(() => store.start(), [store])
  useLinkGestures(store)
  const layout = useSyncExternalStore(store.subscribe, store.snapshot)
  const wide = useWideScreen()
  const [sideHost, setSideHost] = useState<HTMLElement | null>(null)
  const [portraitHost, setPortraitHost] = useState<HTMLElement | null>(null)
  const [panelToggleHost, setPanelToggleHost] = useState<HTMLElement | null>(null)
  const [slots, setSlots] = useState<ReadonlyMap<string, HTMLElement>>(new Map())
  /** A frame's body, where its shown tab's element goes; the returned function forgets it. */
  const slotRef: SlotRef = (frameId, element) => {
    setSlots((before) => {
      if (before.get(frameId) === element) return before
      return new Map(before).set(frameId, element)
    })
    return () =>
      setSlots((before) => {
        if (before.get(frameId) !== element) return before
        const next = new Map(before)
        next.delete(frameId)
        return next
      })
  }
  const shownFrame = focusedFrame(layout)
  const [outer, setOuter] = useState<HTMLElement | null>(null)
  const [center, setCenter] = useState<HTMLElement | null>(null)
  const side = useSideWidth(outer, center)
  const placeholder = usePanelPlaceholder(store, wide, side)
  useKeepDividers(store, outer, center, wide && !layout.maximized)
  // A maximized frame shows alone; the others keep their tabs (VS Code's Maximize Editor Group).
  const maximized = layout.maximized ? frames(layout.root).find((f) => f.id === layout.maximized) : undefined
  return (
    <WorkbenchContext value={{ store, sideHost, portraitHost, panelToggleHost }}>
      <PanelToggleHostRef value={setPanelToggleHost}>
        <div ref={setOuter} className="flex min-h-0 min-w-0 flex-1">
          <div ref={setPortraitHost} className="contents" data-portrait-host />
          <div ref={setCenter} data-workbench className="flex min-h-0 min-w-0 flex-1 flex-col">
            {wide ? (
              <NodeView node={maximized ?? layout.root} layout={layout} store={store} slotRef={slotRef} />
            ) : (
              <PhoneFrame frame={shownFrame} layout={layout} store={store} slotRef={slotRef} />
            )}
          </div>
          <div ref={setSideHost} className="contents" data-side-host />
          {placeholder && <PanelPlaceholder width={placeholder.width} onHide={placeholder.hide} />}
        </div>
      </PanelToggleHostRef>
      {allTabs(layout).map((tab) => {
        const frame = frameOfTab(layout, tab.id)
        const shown =
          frame?.active === tab.id && (wide ? !maximized || frame.id === maximized.id : frame.id === shownFrame.id)
        return (
          <TabHost
            key={tab.id}
            tab={tab}
            store={store}
            target={shown && frame ? (slots.get(frame.id) ?? null) : null}
          />
        )
      })}
    </WorkbenchContext>
  )
}

// --- Links: a double click keeps the item's tab; a plain click on a bare link (in a message)
// opens in the workbench instead of reloading the page.

const appPath = (anchor: HTMLAnchorElement) => {
  if (anchor.target && anchor.target !== "_self") return null
  if (anchor.hasAttribute("download")) return null
  const url = new URL(anchor.href, location.href)
  if (url.origin !== location.origin) return null
  if (/^\/(?:rpc|auth|healthz|media|assets)(?:\/|$)/.test(url.pathname) || /\.[a-z0-9]+$/i.test(url.pathname))
    return null
  return `${url.pathname}${url.search}${url.hash}`
}

function useLinkGestures(store: WorkbenchStore) {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
      const target = event.target instanceof Element ? event.target : null
      const anchor = target?.closest("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = appPath(anchor)
      if (href === null) return
      event.preventDefault()
      // Alt-click: VS Code's Open to the Side, where frames fit side by side.
      if (event.altKey && matchMedia(WIDE).matches) store.openBeside(href)
      // A link inside a frame opens in that frame; outside (the sidebar), wherever it's open.
      else store.openIn(anchor.closest<HTMLElement>("[data-frame]")?.dataset["frame"], href, { whole: true })
    }
    const beside = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail === "string") store.openBeside(detail)
      else if (typeof detail === "object" && detail !== null && "href" in detail && typeof detail.href === "string")
        store.openBeside(detail.href, { preview: "preview" in detail && detail.preview === true })
    }
    window.addEventListener(OPEN_BESIDE, beside)
    const dblclick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = appPath(anchor)
      if (href !== null) store.pinItem(href)
    }
    document.addEventListener("click", click)
    document.addEventListener("dblclick", dblclick)
    return () => {
      window.removeEventListener(OPEN_BESIDE, beside)
      document.removeEventListener("click", click)
      document.removeEventListener("dblclick", dblclick)
    }
  }, [store])
}

// --- A tab: its own router, in its own element.

/** Scroll positions inside an element, to put back when it's shown again. */
const scrolled = (root: HTMLElement) => {
  const kept: Array<[Element, number, number]> = []
  for (const element of root.querySelectorAll("*"))
    if (element.scrollTop !== 0 || element.scrollLeft !== 0) kept.push([element, element.scrollTop, element.scrollLeft])
  return kept
}

function TabHost({ tab, store, target }: { tab: Tab; store: WorkbenchStore; target: HTMLElement | null }) {
  const [container] = useState(() => {
    const element = document.createElement("div")
    element.className = "flex min-h-0 min-w-0 flex-1 flex-col"
    element.dataset["workbenchTab"] = tab.id
    return element
  })
  const [history] = useState(() => {
    const from = store.takeOpenedFrom(tab.id)
    return createMemoryHistory(
      from ? { initialEntries: [from, tab.href], initialIndex: 1 } : { initialEntries: [tab.href] }
    )
  })
  const [router] = useState(() => buildRouter({ history, layouts: { app: CenterPage } }))
  useLayoutEffect(() => store.attach(tab.id, history), [store, tab.id, history])
  useLayoutEffect(
    () =>
      history.block({
        blockerFn: ({ nextLocation, action }) => store.leaves(tab.id, nextLocation.href, nextLocation.state, action),
        enableBeforeUnload: false
      }),
    [store, tab.id, history]
  )
  const kept = useRef<Array<[Element, number, number]>>([])
  useLayoutEffect(() => {
    if (!target) return
    target.append(container)
    for (const [element, top, left] of kept.current) {
      element.scrollTop = top
      element.scrollLeft = left
    }
    kept.current = []
    return () => {
      kept.current = scrolled(container)
      container.remove()
    }
  }, [target, container])
  useEffect(() => () => container.remove(), [container])
  // An editor's tab is a region named for it, its header included (useTabRegion).
  const region = useMeta(store, tab.id)?.region
  useLayoutEffect(() => {
    if (region) {
      container.setAttribute("role", "region")
      container.setAttribute("aria-label", region)
    } else {
      container.removeAttribute("role")
      container.removeAttribute("aria-label")
    }
  }, [container, region])
  // Editing what a tab shows keeps it open (VS Code's preview rule): typing in an editor or a
  // chat's composer. Searching a list or filling a page's form isn't editing a document.
  useEffect(() => {
    const edit = (event: Event) => {
      const href = allTabs(store.snapshot()).find((t) => t.id === tab.id)?.href
      if (!href || !tabKind(href)?.document) return
      const target = event.target
      if (target instanceof HTMLInputElement && target.type === "search") return
      if (target instanceof Element && target.closest('[role="search"], [role="searchbox"], [role="combobox"]')) return
      store.pin(tab.id)
    }
    container.addEventListener("input", edit)
    return () => container.removeEventListener("input", edit)
  }, [container, store, tab.id])
  // What its editors haven't saved yet (their revision state), for the tab's dot.
  const [unsaved] = useState(() => new UnsavedTracker())
  const dirty = useSyncExternalStore(unsaved.subscribe, unsaved.snapshot).size > 0
  useEffect(() => store.setUnsaved(tab.id, dirty), [store, tab.id, dirty])
  useEffect(
    () => () => {
      unsaved.dispose()
      store.setUnsaved(tab.id, false)
    },
    [unsaved, store, tab.id]
  )
  return createPortal(
    <TabContext value={{ tabId: tab.id, store }}>
      <UnsavedScope tracker={unsaved} tab={tab.id}>
        <Away value={target === null}>
          <RouterProvider router={router} />
        </Away>
      </UnsavedScope>
    </TabContext>,
    container
  )
}

// --- Frames and splits.

type SlotRef = (frameId: string, element: HTMLElement) => () => void

/** Registers a frame's body as its tabs' place while mounted. */
function useSlot(slotRef: SlotRef, frameId: string, element: HTMLElement | null) {
  const register = useEffectEvent(() => (element ? slotRef(frameId, element) : undefined))
  useLayoutEffect(() => register(), [frameId, element])
}

/**
 * The width right of the frames: the side panel's, while it shows. Measured as the gap between
 * the frames' right edge and the shell's, so it's the panel's whatever renders it.
 */
function useSideWidth(outer: HTMLElement | null, center: HTMLElement | null) {
  const [side, setSide] = useState(0)
  useLayoutEffect(() => {
    if (!outer || !center) return
    const measure = () =>
      setSide(Math.max(0, Math.round(outer.getBoundingClientRect().right - center.getBoundingClientRect().right)))
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(center)
    measure()
    return () => observer.disconnect()
  }, [outer, center])
  return side
}

/**
 * The side panel's place while no chat is open to fill it (owner, 2026-11-07: "I don't want
 * unexpected layout shifts just because chats close"): the panel's width when its chat was
 * the last one closed with the panel showing; null while a chat has it, before any chat showed
 * it, or once the user hides it.
 */
function usePanelPlaceholder(store: WorkbenchStore, wide: boolean, side: number) {
  const owner = useSyncExternalStore(store.subscribe, () => store.panelOwner(wide))
  // The panel's width while a chat shows it (0 when hidden there), kept when the chat goes.
  const [kept, setKept] = useState(0)
  if (owner !== null && kept !== side) setKept(side)
  if (!wide || owner !== null || kept <= 0) return null
  return { width: kept, hide: () => setKept(0) }
}

/**
 * The frames' width changed from their right edge alone (the side panel shown, hidden or
 * resized; the window and the left columns as they were): the frames along that edge take the
 * change and every divider stays where it was (owner, 2026-11-07: "Why does dragging an image
 * between panes resize other panes?"). Only after the user's first input on the page, so the
 * panel appearing as the page loads leaves the saved shares as they are.
 */
function useKeepDividers(store: WorkbenchStore, outer: HTMLElement | null, center: HTMLElement | null, on: boolean) {
  useLayoutEffect(() => {
    if (!outer || !center || !on) return
    let acted = false
    const act = () => {
      acted = true
    }
    const measure = () => ({
      outer: outer.getBoundingClientRect().width,
      left: center.getBoundingClientRect().left,
      width: center.getBoundingClientRect().width
    })
    let last = measure()
    const observer = new ResizeObserver(() => {
      const was = last
      const now = (last = measure())
      if (!acted || Math.abs(now.outer - was.outer) > 0.5 || Math.abs(now.left - was.left) > 0.5) return
      if (Math.abs(now.width - was.width) < 1) return
      for (const [splitId, sizes] of keepRightEdge(store.layout.root, was.width, now.width))
        store.resize(splitId, sizes)
    })
    observer.observe(outer)
    observer.observe(center)
    window.addEventListener("pointerdown", act, true)
    window.addEventListener("keydown", act, true)
    return () => {
      observer.disconnect()
      window.removeEventListener("pointerdown", act, true)
      window.removeEventListener("keydown", act, true)
    }
  }, [store, outer, center, on])
}

/**
 * New shares for the splits along the right edge when the frames' width goes from `from` to
 * `to`: in a row, every frame but the last keeps its width; a column passes the change to each
 * of its rows. Where room is short, the last frame keeps at least an equal share of the row
 * (or its minimum, if less) and the others give it that.
 */
function keepRightEdge(node: Node, from: number, to: number): Array<[string, ReadonlyArray<number>]> {
  if (node.type === "frame" || from <= 0 || to <= 0) return []
  if (node.direction === "column") return node.children.flatMap((child) => keepRightEdge(child, from, to))
  const shares = node.children.map((_, i) => node.sizes[i] ?? 1 / node.children.length)
  const last = shares.length - 1
  const kept = shares.slice(0, last).map((share) => share * from)
  const keptWidth = kept.reduce((sum, px) => sum + px, 0)
  // Where room is short, the last frame keeps at least an equal share; the others give it that.
  const floor = Math.min(MIN_WIDTH, to / shares.length)
  const lastWidth = Math.max(floor, to - keptWidth)
  const scale = keptWidth > 0 ? (to - lastWidth) / keptWidth : 1
  if (scale <= 0) return []
  return [
    [node.id, [...kept.map((px) => (px * scale) / to), lastWidth / to]],
    ...keepRightEdge(node.children[last]!, shares[last]! * from, lastWidth)
  ]
}

function NodeView({
  node,
  layout,
  store,
  slotRef
}: {
  node: Node
  layout: Layout
  store: WorkbenchStore
  slotRef: SlotRef
}) {
  if (node.type === "frame") return <FrameView frame={node} layout={layout} store={store} slotRef={slotRef} />
  return <SplitView split={node} layout={layout} store={store} slotRef={slotRef} />
}

function SplitView({
  split,
  layout,
  store,
  slotRef
}: {
  split: Split
  layout: Layout
  store: WorkbenchStore
  slotRef: SlotRef
}) {
  const row = split.direction === "row"
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState(0)
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => setSize(row ? element.clientWidth : element.clientHeight)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [element, row])
  const min = row ? MIN_WIDTH : MIN_HEIGHT
  return (
    <div ref={setElement} className={`flex min-h-0 min-w-0 flex-1 ${row ? "flex-row" : "flex-col"}`}>
      {split.children.map((child, index) => {
        const share = split.sizes[index] ?? 1 / split.children.length
        const next = split.sizes[index + 1] ?? 0
        const pair = (share + next) * size
        const resize = (px: number) => {
          if (size <= 0) return
          const clamped = Math.max(min, Math.min(pair - min, px))
          const sizes = [...split.sizes]
          sizes[index] = clamped / size
          sizes[index + 1] = share + next - clamped / size
          store.resize(split.id, sizes)
        }
        return (
          <div
            key={child.id}
            style={{ flex: `${share} 1 0px` }}
            className={`relative flex min-h-0 min-w-0 ${index > 0 ? (row ? "border-l border-border" : "border-t border-border") : ""}`}
          >
            <NodeView node={child} layout={layout} store={store} slotRef={slotRef} />
            {index < split.children.length - 1 && (
              <ResizeHandle
                label={row ? "Resize frames side by side" : "Resize frames above each other"}
                hint={
                  row
                    ? "Drag to change how wide the frames are; double-click to make them equal."
                    : "Drag to change how tall the frames are; double-click to make them equal."
                }
                axis={row ? "x" : "y"}
                width={share * size}
                min={min}
                max={Math.max(min, pair - min)}
                direction={1}
                onChange={resize}
                onReset={() => resize(pair / 2)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The part of the frame the tab will take, shaded while it's dragged over. */
const ZONE_OVERLAY: Record<DropZone, string> = {
  center: "inset-0",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2"
}

/** Native listeners: a tab's content is a portal, so React's events don't pass the frame. */
function useFrameEvents(
  element: HTMLElement | null,
  frameId: string,
  store: WorkbenchStore,
  onDrop: (tabId: string, zone: DropZone) => void
) {
  const [over, setOver] = useState<DropZone | null>(null)
  useEffect(() => {
    if (!element) return
    const focus = () => store.focusFrame(frameId)
    // A tab, or a picture, card or chat of the app's, which opens as a tab (ui/appDrags.ts).
    const isTab = (event: DragEvent) => opensHere(event.dataTransfer)
    const dragover = (event: DragEvent) => {
      if (!isTab(event)) return refuseOther(event)
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      setOver(dropZone(element, event))
    }
    const dragleave = (event: DragEvent) => {
      if (!element.contains(event.relatedTarget as globalThis.Node | null)) setOver(null)
    }
    const drop = (event: DragEvent) => {
      if (!isTab(event)) return
      event.preventDefault()
      setOver(null)
      const payload = dragPayloadOf(event.dataTransfer)
      if (payload) {
        if (payload.href) store.dropOpen(payload.href, frameId, dropZone(element, event))
        return
      }
      const tabId = event.dataTransfer?.getData(TAB_MIME)
      if (tabId) onDrop(tabId, dropZone(element, event))
    }
    element.addEventListener("pointerdown", focus, true)
    element.addEventListener("focusin", focus)
    element.addEventListener("dragover", dragover)
    element.addEventListener("dragleave", dragleave)
    element.addEventListener("drop", drop)
    return () => {
      element.removeEventListener("pointerdown", focus, true)
      element.removeEventListener("focusin", focus)
      element.removeEventListener("dragover", dragover)
      element.removeEventListener("dragleave", dragleave)
      element.removeEventListener("drop", drop)
    }
  }, [element, frameId, store, onDrop])
  return over
}

function FrameView({
  frame,
  layout,
  store,
  slotRef
}: {
  frame: Frame
  layout: Layout
  store: WorkbenchStore
  slotRef: SlotRef
}) {
  const split = isSplit(layout)
  const focused = layout.focused === frame.id
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  useSlot(slotRef, frame.id, body)
  const over = useFrameEvents(body, frame.id, store, (tabId, zone) => {
    if (zone === "center") store.move(tabId, frame.id)
    else
      store.moveToSplit(
        tabId,
        zone === "left" || zone === "right" ? "row" : "column",
        frame.id,
        zone === "left" || zone === "top"
      )
  })
  const strip = frame.tabs.length >= 2 || split
  return (
    <section
      aria-label={split ? "Frame" : "Open tabs"}
      data-frame={frame.id}
      data-focused={focused ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {strip && <TabStrip frame={frame} layout={layout} store={store} tabs={frame.tabs} />}
      <div ref={setBody} data-frame-body className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {frame.tabs.length === 0 && <EmptyFrame frame={frame} store={store} layout={layout} />}
        {over && (
          <div
            aria-hidden="true"
            data-drop-zone={over}
            data-layout-overlay="Drop target covers the part of the frame a dragged tab will take"
            className={`pointer-events-none absolute z-40 border-2 border-accent bg-accent/10 ${ZONE_OVERLAY[over]}`}
          />
        )}
      </div>
    </section>
  )
}

function EmptyFrame({ frame, store, layout }: { frame: Frame; store: WorkbenchStore; layout: Layout }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
      <p>Open a chat, a card or an editor from the sidebar to show it here, or drag a tab here.</p>
      {frames(layout.root).length > 1 && (
        <Tooltip label="Closes this empty frame.">
          <button
            type="button"
            onClick={() => store.closeFrame(frame.id)}
            className="rounded-md px-2 py-1 text-accent outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
          >
            Close frame
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** Phones: one frame's tab at a time; the strip lists every open tab, so all stay reachable. */
function PhoneFrame({
  frame,
  layout,
  store,
  slotRef
}: {
  frame: Frame
  layout: Layout
  store: WorkbenchStore
  slotRef: SlotRef
}) {
  const tabs = allTabs(layout)
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  useSlot(slotRef, frame.id, body)
  return (
    <section aria-label="Open tabs" data-frame={frame.id} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs.length >= 2 && <TabStrip frame={frame} layout={layout} store={store} tabs={tabs} phone />}
      <div ref={setBody} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {frame.tabs.length === 0 && <EmptyFrame frame={frame} store={store} layout={layout} />}
      </div>
    </section>
  )
}

// --- The tab strip.

/** A tab's title and picture; the meta object is replaced on each change. */
const useMeta = (store: WorkbenchStore, tabId: string) =>
  useSyncExternalStore(store.subscribeMeta, () => store.metaOf(tabId))

function TabStrip({
  frame,
  layout,
  store,
  tabs,
  phone = false
}: {
  frame: Frame
  layout: Layout
  store: WorkbenchStore
  tabs: ReadonlyArray<Tab>
  phone?: boolean
}) {
  const focused = layout.focused === frame.id
  const [over, setOver] = useState<number | null>(null)
  // Tab mode's shell buttons (owner, 2026-11-07): the hidden sidebar's Show at the top-left
  // strip's start, the side panel's toggle at the top-right strip's end. Phones have neither.
  const corners = stripCorners(layout)
  const setPanelToggleHost = useContext(PanelToggleHostRef)
  const drop = (event: React.DragEvent, index: number) => {
    const tabId = event.dataTransfer.getData(TAB_MIME)
    // A phone's one frame opens what's picked there; nothing dragged opens on it.
    const href = phone ? "" : (dragPayloadOf(event.dataTransfer)?.href ?? "")
    setOver(null)
    if (!tabId && !href) return
    event.preventDefault()
    event.stopPropagation()
    if (href) store.dropOpen(href, frame.id, "center", index)
    else store.move(tabId, frame.id, index)
  }
  const dragOver = (event: React.DragEvent, index: number) => {
    if (!event.dataTransfer.types.includes(TAB_MIME) && (phone || !dragPayloadOf(event.dataTransfer)))
      return refuseOther(event)
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "move"
    setOver(index)
  }
  return (
    <div
      data-tab-strip
      // In a frame too narrow for everything, the tabs give way first, then Maximize (the ⋯ menu
      // has it too, styles.css); what still doesn't fit is cut at the start, never the end, so
      // the ⋯ menu and the panel's toggle stay inside the frame (sidetoggles review, 2026-11-07).
      className="flex h-9 shrink-0 items-stretch justify-end overflow-hidden border-b border-border bg-surface"
      onDragOver={(event) => dragOver(event, tabs.length)}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => drop(event, tabs.length)}
    >
      {!phone && corners.topLeft === frame.id && (
        // Empty while the sidebar shows; the first tab moves right only while it's hidden.
        <div data-strip-show className="flex shrink-0 items-center px-2 empty:hidden">
          <SlotOutlet slot={sidebarToggle} props={{ place: "strip" }} />
        </div>
      )}
      <div
        role="tablist"
        aria-label="Open tabs"
        data-layout-audit-ignore="inset: tabs fill the strip edge to edge, as an editor's tab bar does"
        onWheel={(event) => {
          // A mouse wheel scrolls the strip sideways, as an editor's tab bar does.
          if (event.deltaY !== 0 && event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] hover:[scrollbar-width:auto]"
      >
        {tabs.map((tab, index) => {
          const owner = frameOfTab(layout, tab.id)
          const active = owner?.active === tab.id && (!phone || owner.id === frame.id)
          return (
            <TabButton
              key={tab.id}
              tab={tab}
              frame={owner ?? frame}
              layout={layout}
              store={store}
              active={active}
              highlighted={active && (focused || phone)}
              dropBefore={over === index}
              onDragOver={(event) => dragOver(event, index)}
              onDrop={(event) => drop(event, index)}
              draggable={!phone}
            />
          )
        })}
        {over === tabs.length && <span aria-hidden="true" data-drop-before className="w-0.5 shrink-0 bg-accent" />}
      </div>
      {!phone && (
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          {isSplit(layout) && (
            <IconButton
              label={layout.maximized === frame.id ? "Restore frames" : "Maximize frame"}
              hint={
                layout.maximized === frame.id
                  ? "Shows every frame again."
                  : "Shows only this frame, until you restore the others."
              }
              icon="expand"
              aria-pressed={layout.maximized === frame.id}
              data-strip-maximize
              onClick={() => store.maximize(layout.maximized === frame.id ? null : frame.id)}
            />
          )}
          <FrameMenu frame={frame} layout={layout} store={store} />
          {corners.topRight === frame.id && (
            <span ref={setPanelToggleHost} className="contents" data-panel-toggle-host />
          )}
        </div>
      )}
    </div>
  )
}

function TabIcon({ tab, store }: { tab: Tab; store: WorkbenchStore }) {
  const meta = useMeta(store, tab.id)
  if (meta?.decoration)
    return (
      <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm">
        {meta.decoration.node}
      </span>
    )
  return <Icon name={tabKind(tab.href)?.icon ?? "panel"} size={14} className="text-muted" />
}

const useTabTitle = (store: WorkbenchStore, tab: Tab) => useMeta(store, tab.id)?.title ?? defaultTitle(tab.href)

function TabButton({
  tab,
  frame,
  layout,
  store,
  active,
  highlighted,
  dropBefore,
  draggable,
  onDragOver,
  onDrop
}: {
  tab: Tab
  frame: Frame
  layout: Layout
  store: WorkbenchStore
  active: boolean
  highlighted: boolean
  dropBefore: boolean
  draggable: boolean
  onDragOver: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
}) {
  const title = useTabTitle(store, tab)
  const unsaved = useSyncExternalStore(store.subscribeMeta, () => store.isUnsaved(tab.id))
  const [menu, setMenu] = useState(false)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  // The shown tab stays in view in a strip that overflows.
  useEffect(() => {
    if (active) element?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active, element])
  return (
    <div
      ref={setElement}
      data-tab={tab.id}
      data-preview={tab.preview ? "" : undefined}
      data-sticky={tab.sticky ? "" : undefined}
      className={`group/tab relative flex max-w-56 shrink-0 items-center border-r border-border ${tab.sticky ? "min-w-16" : "min-w-24"} ${active ? "bg-canvas text-text" : "text-muted hover:bg-hover hover:text-text"}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dropBefore && (
        <span
          aria-hidden="true"
          data-drop-before
          data-layout-overlay="Where a dragged tab drops"
          className="absolute inset-y-0 left-0 w-0.5 bg-accent"
        />
      )}
      {highlighted && (
        <span
          aria-hidden="true"
          data-layout-overlay="The focused frame's tab line"
          className="absolute inset-x-0 top-0 h-0.5 bg-accent"
        />
      )}
      <ContextMenu
        label={`Actions for ${title}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <Tooltip
            label={
              tab.preview
                ? `Shows ${title}. Double-click to keep this tab open. Right-click for more.`
                : `Shows ${title}. Right-click for more.`
            }
            side="bottom"
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              draggable={draggable}
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_MIME, tab.id)
                event.dataTransfer.effectAllowed = "move"
              }}
              onClick={() => store.focusTab(tab.id)}
              onDoubleClick={() => store.pin(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  store.close(tab.id)
                }
              }}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 ps-2 pe-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
            >
              <TabIcon tab={tab} store={store} />
              {/* As wide as the title in either style: keeping a preview moves nothing after it. */}
              <span className="grid min-w-0">
                <span
                  data-layout-name
                  className={`col-start-1 row-start-1 min-w-0 truncate ${tab.preview ? "italic" : ""}`}
                >
                  {title}
                </span>
                <span
                  aria-hidden="true"
                  className={`invisible col-start-1 row-start-1 min-w-0 truncate ${tab.preview ? "" : "italic"}`}
                >
                  {title}
                </span>
              </span>
            </button>
          </Tooltip>
        }
      >
        <TabActions tab={tab} frame={frame} layout={layout} store={store} />
      </ContextMenu>
      {tab.sticky ? (
        <IconButton
          label={`Unpin ${title}`}
          hint="Pinned: first in its frame and kept by Close others, to the right and all. Click to unpin."
          icon="pin"
          filled
          className="me-1 size-6"
          onClick={() => store.stick(tab.id, false)}
        />
      ) : (
        <span className="relative me-1 flex shrink-0 items-center justify-center">
          <IconButton
            label={`Close ${title}`}
            hint={unsaved ? "Has changes not yet saved; they stay with the item. Closes this tab." : "Closes this tab."}
            icon="close"
            className={`size-6 ${unsaved ? "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100" : ""}`}
            onClick={() => store.close(tab.id)}
          />
          {unsaved && (
            <span
              aria-hidden="true"
              data-unsaved-dot
              data-layout-overlay="The unsaved dot takes the close button's place until hovered"
              className="pointer-events-none absolute size-2 rounded-full bg-text group-hover/tab:hidden group-focus-within/tab:hidden"
            />
          )}
        </span>
      )}
    </div>
  )
}

/** The frame's ⋯: what the strip does besides clicks and drags, so moving never needs a drag. */
function FrameMenu({ frame, layout, store }: { frame: Frame; layout: Layout; store: WorkbenchStore }) {
  const tab = frame.tabs.find((t) => t.id === frame.active)
  return (
    <Menu
      label="Tab and frame actions"
      hint="Tab and frame actions: pin, keep open, split, move, close"
      trigger={
        <button type="button" aria-label="Tab and frame actions" className={iconButtonClass()}>
          <Icon name="more" />
        </button>
      }
    >
      <TabActions tab={tab} frame={frame} layout={layout} store={store} />
    </Menu>
  )
}

/**
 * What can be done with a tab and its frame: the frame's ⋯ (for the shown tab) and a tab's
 * right-click menu (for that tab) list the same, as VS Code's tab context menu does.
 */
function TabActions({
  tab,
  frame,
  layout,
  store
}: {
  tab: Tab | undefined
  frame: Frame
  layout: Layout
  store: WorkbenchStore
}) {
  const near = neighbours(layout, frame.id)
  const split = frames(layout.root).length > 1
  const index = tab ? frame.tabs.findIndex((t) => t.id === tab.id) : -1
  const closable = (t: Tab) => !t.sticky
  const others = frame.tabs.filter((t) => t.id !== tab?.id && closable(t)).length
  const right = frame.tabs.slice(index + 1).filter(closable).length
  const saved = frame.tabs.filter((t) => closable(t) && !store.isUnsaved(t.id)).length
  const all = frame.tabs.filter(closable).length
  type Item = { action: LayoutAction; icon: IconName; label: string; description: string }
  const moves: Array<Item> = tab
    ? [
        ...(
          [
            ["left", near.left, "the frame on the left"],
            ["right", near.right, "the frame on the right"],
            ["up", near.up, "the frame above"],
            ["down", near.down, "the frame below"]
          ] as const
        ).map(([side, to, where]) => ({
          action: { type: "move" as const, tabId: tab.id, frameId: to },
          icon: `move-${side}` as IconName,
          label: `Move to ${where}`,
          description: `Moves this tab into ${where}.`
        })),
        ...(
          [
            ["row", true, "on the left"],
            ["row", false, "on the right"],
            ["column", true, "above"],
            ["column", false, "below"]
          ] as const
        ).map(([direction, before, where]) => ({
          action: { type: "moveToNewFrame" as const, tabId: tab.id, direction, before },
          icon: (direction === "row" ? "split-right" : "split-down") as IconName,
          label: `Move to a new frame ${where}`,
          description: `Moves this tab into a new frame ${where}.`
        }))
      ]
    : []
  // An item that wouldn't change the layout is disabled, saying why.
  const why = (action: LayoutAction) => {
    const can = canApply(layout, action, itemKey)
    if (can === "yes") return undefined
    if (can === "same") return "It's already there."
    const alone = frames(layout.root).length === 1 && frame.tabs.length === 1
    return action.type === "move" && !alone ? "No frame there." : "Needs another tab or pane."
  }
  const splittable = (direction: Direction) =>
    tab !== undefined && canApply(layout, { type: "split", frameId: frame.id, direction }) === "yes"
  const splitWith = (direction: Direction) => {
    if (!tab) return
    store.focusTab(tab.id)
    store.split(frame.id, direction)
  }
  return (
    <>
      <MenuItem
        icon="pin"
        disabled={!tab}
        description={
          tab?.sticky
            ? "Unpins this tab: it can be closed with the others again."
            : "Keeps this tab first in its frame; Close others, to the right and all leave it open."
        }
        onClick={() => tab && store.stick(tab.id, !tab.sticky)}
      >
        {tab?.sticky ? "Unpin tab" : "Pin tab"}
      </MenuItem>
      <MenuItem
        icon="check"
        disabled={!tab?.preview}
        description={tab?.preview ? "The next item you open gets its own tab." : "This tab is kept open already."}
        onClick={() => tab && store.pin(tab.id)}
      >
        Keep tab open
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon="split-right"
        disabled={!splittable("row")}
        description={
          splittable("row") ? "Shows this tab in a second frame on the right too." : "Nothing shown to split."
        }
        onClick={() => splitWith("row")}
      >
        Split right
      </MenuItem>
      <MenuItem
        icon="split-down"
        disabled={!splittable("column")}
        description={splittable("column") ? "Shows this tab in a second frame below too." : "Nothing shown to split."}
        onClick={() => splitWith("column")}
      >
        Split down
      </MenuItem>
      {moves.map((move) => {
        const reason = why(move.action)
        return (
          <MenuItem
            key={move.label}
            icon={move.icon}
            disabled={reason !== undefined}
            description={reason ?? move.description}
            onClick={() => reason === undefined && store.act(move.action)}
          >
            {move.label}
          </MenuItem>
        )
      })}
      {split && (
        <MenuItem
          icon="expand"
          description={
            layout.maximized === frame.id
              ? "Shows every frame again."
              : "Shows only this frame, until you restore the others."
          }
          onClick={() => store.maximize(layout.maximized === frame.id ? null : frame.id)}
        >
          {layout.maximized === frame.id ? "Restore frames" : "Maximize frame"}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon="close"
        disabled={!tab}
        description="Closes this tab. Text typed in it stays with the item."
        onClick={() => tab && store.close(tab.id)}
      >
        Close tab
      </MenuItem>
      <MenuItem
        icon="close"
        disabled={!tab || others === 0}
        description={
          others === 0
            ? "No other tab here can close (pinned tabs stay)."
            : "Closes every other tab in this frame except pinned ones."
        }
        onClick={() => tab && store.closeTabs(tab.id, "others")}
      >
        Close other tabs
      </MenuItem>
      <MenuItem
        icon="close"
        disabled={!tab || right === 0}
        description={
          right === 0 ? "No tab to the right can close." : "Closes the tabs after this one, except pinned ones."
        }
        onClick={() => tab && store.closeTabs(tab.id, "right")}
      >
        Close tabs to the right
      </MenuItem>
      <MenuItem
        icon="close"
        disabled={!tab || saved === 0}
        description={
          saved === 0
            ? "Every tab here has changes not yet saved, or is pinned."
            : "Closes the tabs here with nothing unsaved, except pinned ones."
        }
        onClick={() => tab && store.closeTabs(tab.id, "saved")}
      >
        Close saved tabs
      </MenuItem>
      <MenuItem
        icon="close"
        disabled={!tab || all === 0}
        description={all === 0 ? "Every tab here is pinned." : "Closes every tab in this frame except pinned ones."}
        onClick={() => tab && store.closeTabs(tab.id, "all")}
      >
        Close all tabs
      </MenuItem>
      <MenuItem
        icon="undo"
        disabled={!store.canReopen}
        description={
          store.canReopen ? "Opens the tab you closed last again." : "No tab was closed since the page opened."
        }
        onClick={() => store.reopenClosed()}
      >
        Reopen closed tab
      </MenuItem>
      <MenuItem
        icon="close"
        disabled={!split}
        description={split ? "Closes this frame and its tabs." : "The only frame stays open."}
        onClick={() => store.closeFrame(frame.id)}
      >
        Close frame
      </MenuItem>
    </>
  )
}

// --- The header's split buttons (`centerHeaderEnd`).

export function SplitButtons(): ReactNode {
  const tab = useWorkbenchTab()
  const wide = useWideScreen()
  const shown = useTabShown(wide)
  if (!tab || !wide || !shown) return null
  const split = (direction: "row" | "column") => {
    const frame = frameOfTab(tab.store.layout, tab.tabId)
    if (frame) tab.store.split(frame.id, direction)
  }
  return (
    <>
      <span className="contents @max-[40rem]/header:hidden">
        <IconButton
          label="Split right"
          hint="Shows this in a second frame on the right too, to open something beside it."
          icon="split-right"
          onClick={() => split("row")}
        />
        <IconButton
          label="Split down"
          hint="Shows this in a second frame below too, to open something beside it."
          icon="split-down"
          onClick={() => split("column")}
        />
      </span>
      <span className="hidden @max-[40rem]/header:contents">
        <Menu
          label="Split"
          hint="Splits the view into frames"
          trigger={
            <button
              type="button"
              aria-label="Split"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name="split-right" />
            </button>
          }
        >
          <MenuItem
            icon="split-right"
            description="Shows this in a second frame on the right too."
            onClick={() => split("row")}
          >
            Split right
          </MenuItem>
          <MenuItem
            icon="split-down"
            description="Shows this in a second frame below too."
            onClick={() => split("column")}
          >
            Split down
          </MenuItem>
        </Menu>
      </span>
    </>
  )
}
