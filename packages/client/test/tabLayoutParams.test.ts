import { createMemoryHistory } from "@tanstack/react-router"
import { afterEach, expect, it, vi } from "vitest"
import { WorkbenchStore } from "../src/features/workbench/store.ts"
import { focusedTab } from "../src/features/workbench/model.ts"
import {
  holdLayoutWrites,
  layoutParams,
  readLayoutParam,
  setLayoutHistory,
  whenDragEnds,
  withoutLayoutParams,
  writeLayoutParam
} from "../src/tabLayoutParams.ts"
import { decodeChoices, encodeChoices, KEPT } from "../src/ui/openBlocks.ts"
import { actsOn } from "../src/ui/ResizeHandle.tsx"
import { shownPlaceValue, spentOverride } from "../src/usePlaceParam.ts"
import { decodeOpen, encodeOpen, OPEN_LIMIT } from "../src/features/editor/lorebookOpen.ts"
import { decodeWeights, keptWeights, MAX_WEIGHTS } from "../src/features/chat/ChatPortraitProvider.tsx"
import { decodeLayout, encodeLayout, WB_LIMIT } from "../src/features/workbench/layoutParam.ts"
import {
  initialLayout,
  openTab,
  restoreLayout,
  splitFrame,
  allTabs,
  closeTab,
  frames,
  pinTab,
  stickTab
} from "../src/features/workbench/model.ts"
import { register as registerFiles } from "../src/features/files/index.tsx"
import { filesHref } from "../src/features/files/href.ts"
import { itemKey } from "../src/features/workbench/kinds.ts"

const off: Array<() => void> = []
afterEach(() => {
  for (const stop of off.splice(0)) stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const register = (keys: ReadonlyArray<string>) => off.push(layoutParams.register({ id: `test.${keys.join()}`, keys }))

it("writes a layout param into the browser's URL, replacing its entry, and removes it at the default", () => {
  register(["sidebar"])
  const history = createMemoryHistory({ initialEntries: ["/a", "/chats/1?q=x"] })
  setLayoutHistory(history)
  const length = history.length
  writeLayoutParam("sidebar", "hidden")
  expect(history.location.href).toBe("/chats/1?q=x&sidebar=hidden")
  expect(history.length).toBe(length)
  expect(readLayoutParam("sidebar")).toBe("hidden")
  writeLayoutParam("sidebar", null)
  expect(history.location.href).toBe("/chats/1?q=x")
  expect(readLayoutParam("sidebar")).toBeNull()
})

it("reads the URL it loaded with, and carries the layout over navigation, Back and Forward included", async () => {
  register(["sbw", "sidebar"])
  const history = createMemoryHistory({ initialEntries: ["/a", "/b?sbw=410"], initialIndex: 1 })
  setLayoutHistory(history)
  expect(readLayoutParam("sbw")).toBe("410")
  writeLayoutParam("sidebar", "hidden")
  // A navigation that names none of it: the entry gets it back, once what follows has run.
  history.push("/c?q=1")
  await Promise.resolve()
  expect(history.location.href).toBe("/c?q=1&sbw=410&sidebar=hidden")
  // Back goes to the page before, keeping the layout as it is now.
  history.back()
  await Promise.resolve()
  expect(history.location.pathname).toBe("/b")
  expect(readLayoutParam("sidebar")).toBe("hidden")
  expect(new URLSearchParams(history.location.search).get("sidebar")).toBe("hidden")
  history.back()
  await Promise.resolve()
  expect(history.location.href).toBe("/a?sbw=410&sidebar=hidden")
})

it("a held drag shows its values at once and writes the URL once, when it ends", () => {
  register(["sbw"])
  const history = createMemoryHistory({ initialEntries: ["/"] })
  setLayoutHistory(history)
  const changes: Array<string> = []
  const stop = history.subscribe(() => changes.push(history.location.href))
  const release = holdLayoutWrites()
  writeLayoutParam("sbw", "300")
  writeLayoutParam("sbw", "315")
  let page = 0
  whenDragEnds("sizes", () => (page = 1))
  whenDragEnds("sizes", () => (page = 2))
  expect(readLayoutParam("sbw")).toBe("315")
  expect(changes).toEqual([])
  expect(page).toBe(0)
  release()
  release()
  stop()
  expect(changes).toEqual(["/?sbw=315"])
  expect(page).toBe(2)
  // No drag: at once.
  whenDragEnds("sizes", () => (page = 3))
  expect(page).toBe(3)
})

it("keeps layout params off a workbench tab's URL and on the browser's through the tab's navigation", () => {
  vi.useFakeTimers()
  vi.stubGlobal("window", new EventTarget())
  register(["sidebar", "sbw"])
  expect(withoutLayoutParams("/chats/a?sidebar=hidden&panel=cast&sbw=300")).toBe("/chats/a?panel=cast")
  const browser = createMemoryHistory({ initialEntries: ["/chats/a?sidebar=hidden&sbw=300"] })
  setLayoutHistory(browser)
  const store = new WorkbenchStore("user", browser, null, () => {})
  const stop = store.start()
  expect(focusedTab(store.layout)?.href).toBe("/chats/a")
  const tab = createMemoryHistory({ initialEntries: ["/chats/a"] })
  const detach = store.attach(focusedTab(store.layout)!.id, tab)
  // The tab's own navigation, which names no layout: the browser keeps it.
  tab.push("/chats/a?panel=notes")
  expect(browser.location.href).toBe("/chats/a?panel=notes&sidebar=hidden&sbw=300")
  // Another item opened: the same.
  store.open("/chats/b?sidebar=hidden")
  expect(focusedTab(store.layout)?.href).toBe("/chats/b")
  expect(new URLSearchParams(browser.location.search).get("sidebar")).toBe("hidden")
  expect(new URLSearchParams(browser.location.search).get("sbw")).toBe("300")
  detach()
  stop()
  vi.runAllTimers()
})

it("encodes a list's block choices: Expand or Collapse all as a mode, then each block's, capped", () => {
  const each = new Map([
    ["a", true],
    ["b", false]
  ])
  expect(encodeChoices({ each })).toEqual(["a", "!b"])
  expect(decodeChoices(["a", "!b", 3, "", "!"])).toEqual({ each })
  expect(encodeChoices({ all: true, each })).toEqual(["*", "a", "!b"])
  expect(decodeChoices(["!*", "a"])).toEqual({ all: false, each: new Map([["a", true]]) })
  expect(encodeChoices({ each: new Map() })).toBeUndefined()
  expect(decodeChoices("junk")).toEqual({ each: new Map() })
  // However many blocks get a choice, the URL keeps the last KEPT.
  const many = new Map(
    Array.from({ length: 400 }, (_, i) => [`0190a5c0-0000-7000-8000-${String(i).padStart(12, "0")}`, true])
  )
  const kept = encodeChoices({ all: false, each: many })!
  expect(kept).toHaveLength(KEPT + 1)
  expect(encodeURIComponent(JSON.stringify(kept)).length).toBeLessThan(1200)
  // A hostile URL's long list reads as its last KEPT.
  expect(decodeChoices(Array.from({ length: 5000 }, (_, i) => `x${i}`)).each.size).toBe(KEPT)
})

it("keeps a lorebook view's open entries short: Expand all on 2000 entries is a mode", () => {
  const uids = Array.from({ length: 2000 }, (_, i) => i + 1)
  expect(encodeOpen(new Set([3, 9]), uids)).toEqual([3, 9])
  expect(encodeOpen(new Set(), uids)).toBeUndefined()
  expect(decodeOpen([3, "9", "x", 1.5], uids)).toEqual(new Set([3, 9]))
  expect(decodeOpen(undefined, uids)).toEqual(new Set())
  // Expand all, then two closed: "all" and the two.
  const open = new Set(uids.filter((uid) => uid !== 5 && uid !== 7))
  const value = encodeOpen(open, uids, true)!
  expect(value).toEqual(["all", 5, 7])
  // Opened one by one, even all of a one-entry book: a list, so later entries stay closed.
  expect(encodeOpen(new Set([4]), [4])).toEqual([4])
  expect(encodeOpen(open, uids)).toHaveLength(OPEN_LIMIT)
  expect(decodeOpen(value, uids)).toEqual(open)
  expect(encodeURIComponent(JSON.stringify(encodeOpen(new Set(uids), uids, true))).length).toBeLessThan(40)
  // Half open, one by one: at most OPEN_LIMIT uids, well under 2 KB with the rest of the URL.
  const half = encodeOpen(new Set(uids.slice(0, 1000)), uids)!
  expect(half).toHaveLength(OPEN_LIMIT)
  expect(encodeURIComponent(JSON.stringify(half)).length).toBeLessThan(600)
  expect(
    decodeOpen(
      Array.from({ length: 9000 }, (_, i) => i),
      uids
    ).size
  ).toBeLessThanOrEqual(OPEN_LIMIT + 1)
})

it("in Expand all mode keeps the most recently closed entry when the URL's exceptions fill up", () => {
  const uids = Array.from({ length: 100 }, (_, i) => i + 1)
  const closed = uids.slice(50)
  const previous = ["all", ...closed]
  const open = new Set(decodeOpen(previous, uids))
  open.delete(1)
  const next = encodeOpen(open, uids, true, previous)
  expect(next).toEqual(["all", ...closed.slice(1), 1])
  expect(decodeOpen(next, uids).has(1)).toBe(false)
  expect(decodeOpen(next, uids).has(51)).toBe(true)
})

it("shows a place value just set until the URL's value moves, then never again (Back after it)", () => {
  // Set [3] while the URL had none: shown until the URL changes.
  const local = { base: "undefined", value: [3] }
  expect(shownPlaceValue(local, undefined)).toEqual([3])
  expect(spentOverride(local, undefined)).toBe(false)
  // The replace lands: the URL's [3] shows, and the override is spent.
  expect(shownPlaceValue(local, [3])).toEqual([3])
  expect(spentOverride(local, [3])).toBe(true)
  // Once dropped, Back to the entry without it shows none.
  expect(shownPlaceValue(null, undefined)).toBeUndefined()
  expect(shownPlaceValue({ base: "[1]", value: [1, 2] }, [4])).toEqual([4])
})

it("puts the workbench's frames in one compact param, the focused tab as the URL's, and reads them back", () => {
  const key = (href: string) => href.split("?")[0]!
  let layout = initialLayout("/chats/a")
  layout = openTab(layout, "/chats/a", key, { preview: false })
  layout = openTab(layout, "/library/p?x=1", key, { preview: false })
  layout = splitFrame(layout, layout.focused, "row")
  layout = openTab(layout, "/chats/b", key, { preview: false })
  const text = encodeLayout(layout, (href) => href)!
  expect(text).toBe('["r",[0.5,0.5],[1,"/chats/a","/library/p?x=1"],[1,"/library/p?x=1","="]]')
  const back = restoreLayout(decodeLayout(text, "/chats/b?fork=2"))!
  expect(frames(back.root).map((f) => f.tabs.map((t) => t.href))).toEqual([
    ["/chats/a", "/library/p?x=1"],
    ["/library/p?x=1", "/chats/b?fork=2"]
  ])
  const focused = frames(back.root).find((f) => f.id === back.focused)!
  expect(focused.tabs.find((t) => t.id === focused.active)?.href).toBe("/chats/b?fork=2")
  // One tab alone: no param; a login page is left out; junk reads as nothing.
  expect(encodeLayout(initialLayout("/"), (href) => href)).toBeNull()
  expect(decodeLayout("not json", "/")).toBeNull()
  expect(restoreLayout(decodeLayout('{"a":1}', "/"))).toBeNull()
  expect(
    allTabs(restoreLayout(decodeLayout('[0,"~/x","^/y","="]', "/z"))!).map((t) => [
      t.href,
      t.preview,
      t.sticky ?? false
    ])
  ).toEqual([
    ["/y", false, true],
    ["/x", true, false],
    ["/z", false, false]
  ])
})

it.each([true, false])("restores a lone kept tab after closing its neighbor (pinned: %s)", (sticky) => {
  const key = (href: string) => href
  const initial = initialLayout("/chats/a")
  const id = focusedTab(initial)!.id
  let layout = sticky ? stickTab(initial, id, true) : pinTab(initial, id)
  layout = openTab(layout, "/chats/b", key)
  layout = closeTab(layout, focusedTab(layout)!.id)
  const restored = restoreLayout(decodeLayout(encodeLayout(layout, key), "/chats/a"))!
  expect(focusedTab(restored)).toMatchObject({ href: "/chats/a", preview: false })
  expect(focusedTab(restored)?.sticky ?? false).toBe(sticky)
  expect(allTabs(openTab(restored, "/chats/c", key)).map((t) => t.href)).toEqual(["/chats/a", "/chats/c"])
})

it("keeps the workbench param under its budget, dropping the place params of the least recent other frames' tabs first", () => {
  const key = (href: string) => href.split("?")[0]!
  const place = `?${"lb:open=" + encodeURIComponent(JSON.stringify(Array.from({ length: 50 }, (_, i) => i)))}&timeline=summaries`
  const fits = (text: string) => new URLSearchParams({ wb: text }).toString().length <= WB_LIMIT
  let layout = initialLayout("/chats/focused-0")
  for (let i = 1; i < 30; i++) layout = openTab(layout, `/chats/left-${i}${place}`, key, { preview: false })
  layout = splitFrame(layout, layout.focused, "row")
  for (let i = 0; i < 3; i++) layout = openTab(layout, `/chats/right-${i}${place}`, key, { preview: false })
  const text = encodeLayout(layout, (href) => href)!
  expect(fits(text)).toBe(true)
  const back = restoreLayout(decodeLayout(text, "/chats/now"))!
  const [left, right] = frames(back.root)
  // The focused frame's hidden tabs keep theirs; in the other frame the most recent tab keeps
  // its own while the least recent lost theirs; every tab is still there.
  expect(right!.tabs.filter((t) => t.href.includes("timeline=summaries"))).toHaveLength(right!.tabs.length - 1)
  expect(left!.tabs).toHaveLength(29)
  expect(left!.tabs.find((t) => t.href.startsWith("/chats/left-29"))?.href).toContain("timeline=summaries")
  expect(left!.tabs.find((t) => t.href.startsWith("/chats/left-1"))?.href).toBe("/chats/left-1")
  // Under the budget, nothing is dropped.
  expect(encodeLayout(layout, (href) => href, undefined, 1_000_000)).toContain("left-1?")
  // A focused frame too big alone: its hidden tabs go too, after the other frame's.
  for (let i = 3; i < 40; i++) layout = openTab(layout, `/chats/right-${i}${place}`, key, { preview: false })
  expect(fits(encodeLayout(layout, (href) => href)!)).toBe(true)
})

it("keeps Files folders and open filenames when compacting hidden tabs", () => {
  off.push(...registerFiles())
  const folder = `/files/${Array.from({ length: 5 }, () => "雪".repeat(15)).join("/")}`
  const hrefs = [filesHref(folder), filesHref(folder, "first.txt"), filesHref(folder, "second.txt")]
  let layout = initialLayout(hrefs[0]!)
  for (const href of hrefs)
    layout = openTab(layout, `${href}&presentation=${"p".repeat(WB_LIMIT)}`, itemKey, { preview: false })
  layout = openTab(layout, "/chats/current", itemKey, { preview: false })
  const encoded = encodeLayout(layout, (href) => href)!
  expect(new URLSearchParams({ wb: encoded }).toString().length).toBeLessThanOrEqual(WB_LIMIT)
  const restored = restoreLayout(decodeLayout(encoded, "/chats/current"))!
  expect(allTabs(restored).map((t) => t.href)).toEqual([...hrefs, "/chats/current"])
})

it("writes portrait shares as it reads them back: the same cap, rounding and bounds", () => {
  const shown = Array.from({ length: 15 }, (_, i) => [`p${i}`, i === 0 ? 0.0001 : 1 + i / 3.3333] as const)
  const kept = keptWeights(shown)
  expect(Object.keys(kept)).toHaveLength(MAX_WEIGHTS)
  expect(decodeWeights(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
})

it("a resize grip holds URL writes only for the keys it acts on", () => {
  expect(actsOn("ArrowLeft", false)).toBe(true)
  expect(actsOn("ArrowUp", false)).toBe(false)
  expect(actsOn("ArrowUp", true)).toBe(true)
  expect(actsOn("ArrowRight", true)).toBe(false)
  expect(actsOn("End", true)).toBe(true)
  expect(actsOn("a", false)).toBe(false)
})
