// The center column as frames of tabs (owner, 2026-11-05; DESIGN §10.1): VS Code's split view
// with tabs. One item and no split looks as the single view did; the strip appears once a
// frame has two tabs or the column is split. The side panel stays beside the frames and shows
// the chat focused last (tab.tsx `useSidePanelPlace`).
//
// Each tab renders its own router (TabHost) into an element of its own, which is put in its
// frame while shown and taken out of the page while not: its state, scroll and drafts stay,
// and nothing hidden is left in the page to find or to focus.
import { useAtomValue } from "@effect/atom-react"
import { createMemoryHistory, RouterProvider, useRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { createPortal } from "react-dom"
import { buildRouter } from "../../routes.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { useCaller } from "../editor/caller.ts"
import { Away } from "../../ui/away.ts"
import { Icon } from "../../ui/Icon.tsx"
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { UnsavedScope, UnsavedTracker } from "../../ui/UnsavedChanges.tsx"
import { Tooltip, IconButton } from "../../ui/Tooltip.tsx"
import { CenterPage } from "../shell.tsx"
import { defaultTitle, tabKind } from "./kinds.ts"
import {
  allTabs,
  type Frame,
  focusedFrame,
  frameOfTab,
  frames,
  isSplit,
  type Layout,
  neighbours,
  type Node,
  type Split,
  type Tab,
  type Direction
} from "./model.ts"
import { deviceId } from "./device.ts"
import { OPEN_BESIDE } from "./OpenBeside.tsx"
import { WorkbenchStore } from "./store.ts"
import { TabContext, useTabShown, useWorkbenchTab, WorkbenchContext } from "./tab.tsx"

const TAB_MIME = "application/x-rp-workbench-tab"
const MIN_WIDTH = 320
const MIN_HEIGHT = 160

const WIDE = "(min-width: 1024px)"
const subscribeWide = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const useWideScreen = () => useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches)

const savedFor = Atom.family((_userId: string) =>
  AppClient.runtime.atom(
    Effect.gen(function* () {
      const client = yield* AppClient
      return yield* client("GetWorkbenchLayout", { device: deviceId() })
    })
  )
)

/** Registered in the shell's center column (`centerColumn`). */
export function Workbench() {
  const userId = useSession().user.id
  const result = useAtomValue(savedFor(userId))
  // A layout that can't be read starts fresh: the column must open either way.
  if (AsyncResult.isInitial(result)) return null
  const saved = AsyncResult.isSuccess(result) && result.value !== null ? parse(result.value) : null
  return <WorkbenchFor key={userId} userId={userId} saved={saved} />
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function WorkbenchFor({ userId, saved }: { userId: string; saved: unknown }) {
  const router = useRouter()
  const call = useCaller()
  const [store] = useState(
    () =>
      new WorkbenchStore(
        userId,
        router.history,
        saved,
        (layout) => void call((client) => client("SetWorkbenchLayout", { device: deviceId(), layout }))
      )
  )
  useEffect(() => store.start(), [store])
  useLinkGestures(store)
  const layout = useSyncExternalStore(store.subscribe, store.snapshot)
  const wide = useWideScreen()
  const [sideHost, setSideHost] = useState<HTMLElement | null>(null)
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
  // A maximized frame shows alone; the others keep their tabs (VS Code's Maximize Editor Group).
  const maximized = layout.maximized ? frames(layout.root).find((f) => f.id === layout.maximized) : undefined
  return (
    <WorkbenchContext value={{ store, sideHost }}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div data-workbench className="flex min-h-0 min-w-0 flex-1 flex-col">
          {wide ? (
            <NodeView node={maximized ?? layout.root} layout={layout} store={store} slotRef={slotRef} />
          ) : (
            <PhoneFrame frame={shownFrame} layout={layout} store={store} slotRef={slotRef} />
          )}
        </div>
        <div ref={setSideHost} className="contents" data-side-host />
      </div>
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
      else store.open(href)
    }
    const beside = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") store.openBeside(event.detail)
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

/** Where over a frame a dragged tab drops: into it, or into a new frame on that side. */
type DropZone = "center" | "left" | "right" | "top" | "bottom"

/** VS Code's: the outer quarter on each side splits there; nearest edge first in a corner. */
const dropZone = (element: HTMLElement, event: DragEvent): DropZone => {
  const box = element.getBoundingClientRect()
  const x = (event.clientX - box.left) / box.width
  const y = (event.clientY - box.top) / box.height
  const edges: Array<[DropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y]
  ]
  const [zone, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  return distance < 0.25 ? zone : "center"
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
    const isTab = (event: DragEvent) => event.dataTransfer?.types.includes(TAB_MIME) ?? false
    const dragover = (event: DragEvent) => {
      if (!isTab(event)) return
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
      <div ref={setBody} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
  const drop = (event: React.DragEvent, index: number) => {
    const tabId = event.dataTransfer.getData(TAB_MIME)
    setOver(null)
    if (!tabId) return
    event.preventDefault()
    event.stopPropagation()
    store.move(tabId, frame.id, index)
  }
  const dragOver = (event: React.DragEvent, index: number) => {
    if (!event.dataTransfer.types.includes(TAB_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "move"
    setOver(index)
  }
  return (
    <div
      data-tab-strip
      className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface"
      onDragOver={(event) => dragOver(event, tabs.length)}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => drop(event, tabs.length)}
    >
      <div
        role="tablist"
        aria-label="Open tabs"
        data-layout-audit-ignore="inset: tabs fill the strip edge to edge, as an editor's tab bar does"
        onWheel={(event) => {
          // A mouse wheel scrolls the strip sideways, as an editor's tab bar does.
          if (event.deltaY !== 0 && event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] hover:[scrollbar-width:thin]"
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
        {over === tabs.length && <span aria-hidden="true" className="w-0.5 shrink-0 bg-accent" />}
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
              className="size-7"
              onClick={() => store.maximize(layout.maximized === frame.id ? null : frame.id)}
            />
          )}
          <FrameMenu frame={frame} layout={layout} store={store} />
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
                <span className={`col-start-1 row-start-1 min-w-0 truncate ${tab.preview ? "italic" : ""}`}>
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
        <button
          type="button"
          aria-label="Tab and frame actions"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
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
  const moves: Array<{ to: string | undefined; label: string; description: string }> = [
    {
      to: near.left,
      label: "Move to the frame on the left",
      description: "Moves this tab into the frame on the left."
    },
    {
      to: near.right,
      label: "Move to the frame on the right",
      description: "Moves this tab into the frame on the right."
    },
    { to: near.up, label: "Move to the frame above", description: "Moves this tab into the frame above." },
    { to: near.down, label: "Move to the frame below", description: "Moves this tab into the frame below." }
  ]
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
        disabled={!tab}
        description="Shows this tab in a second frame on the right too."
        onClick={() => splitWith("row")}
      >
        Split right
      </MenuItem>
      <MenuItem
        icon="split-down"
        disabled={!tab}
        description="Shows this tab in a second frame below too."
        onClick={() => splitWith("column")}
      >
        Split down
      </MenuItem>
      {moves.flatMap((move) =>
        move.to && tab
          ? [
              <MenuItem
                key={move.label}
                icon="right"
                description={move.description}
                onClick={() => store.move(tab.id, move.to!)}
              >
                {move.label}
              </MenuItem>
            ]
          : []
      )}
      <MenuItem
        icon="split-right"
        disabled={!tab}
        description="Moves this tab into a new frame on the right."
        onClick={() => tab && store.moveToSplit(tab.id, "row")}
      >
        Move to a new frame on the right
      </MenuItem>
      <MenuItem
        icon="split-down"
        disabled={!tab}
        description="Moves this tab into a new frame below."
        onClick={() => tab && store.moveToSplit(tab.id, "column")}
      >
        Move to a new frame below
      </MenuItem>
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
