import { createMemoryHistory } from "@tanstack/react-router"
import { afterEach, expect, it, vi } from "vitest"
import { allTabs, focusedTab, saveLayout } from "../src/features/workbench/model.ts"
import { WorkbenchStore } from "../src/features/workbench/store.ts"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("replaces an earlier layout when a fresh URL opens, even without further interaction", () => {
  vi.useFakeTimers()
  vi.stubGlobal("window", new EventTarget())
  const earlier = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/chats/a"] }), null, () => {})
  earlier.split(earlier.frames()[0]!.id, "row")
  let saved = JSON.stringify(saveLayout(earlier.layout))
  const fresh = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/"] }), null, (json) => {
    saved = json
  })
  const stop = fresh.start()
  window.dispatchEvent(new Event("pagehide"))
  stop()

  const reloaded = new WorkbenchStore(
    "user",
    createMemoryHistory({ initialEntries: ["/"] }),
    JSON.parse(saved),
    () => {}
  )
  expect(reloaded.frames()).toHaveLength(1)
  expect(allTabs(reloaded.layout).map((tab) => tab.href)).toEqual(["/"])
})

it.each([0, 1, 2])("opens a new picture at each strip boundary with tab %i active", (active) => {
  vi.useFakeTimers()
  for (const index of [0, 1, 2, 3]) {
    const hrefs = ["/chats/a", "/chats/b", "/chats/c"]
    const store = new WorkbenchStore("user", createMemoryHistory({ initialEntries: [hrefs[0]!] }), null, () => {})
    store.pin(focusedTab(store.layout)!.id)
    store.open(hrefs[1]!, { preview: false })
    store.open(hrefs[2]!, { preview: false })
    const frame = store.frames()[0]!
    store.focusTab(frame.tabs[active]!.id)
    const picture = "/picture?media=synthetic&name=Portrait"
    store.dropOpen(picture, frame.id, "center", index)
    expect(store.frames()[0]!.tabs.map((tab) => tab.href)).toEqual([
      ...hrefs.slice(0, index),
      picture,
      ...hrefs.slice(index)
    ])
    expect(focusedTab(store.layout)?.href).toBe(picture)
  }
  vi.runAllTimers()
})

it("dropping an already-open picture reorders its kept tab without duplicating it", () => {
  vi.useFakeTimers()
  const picture = "/picture?media=synthetic&name=Portrait"
  const store = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/chats/a"] }), null, () => {})
  const chat = focusedTab(store.layout)!.id
  const frame = store.frames()[0]!.id
  store.dropOpen(picture, frame, "center")
  const id = focusedTab(store.layout)!.id
  store.dropOpen(picture, frame, "center", 0)
  expect(store.frames()[0]!.tabs.map((tab) => tab.id)).toEqual([id, chat])
  store.dropOpen(picture, frame, "center", 2)
  expect(store.frames()[0]!.tabs.map((tab) => tab.id)).toEqual([chat, id])
  expect(store.frames()[0]!.tabs.every((tab) => !tab.preview)).toBe(true)
  vi.runAllTimers()
})

it.each(["left", "right", "top", "bottom"] as const)(
  "a picture dropped on the %s survives closing its source frame, moving and reload",
  (zone) => {
    vi.useFakeTimers()
    const browser = createMemoryHistory({ initialEntries: ["/chats/a"] })
    const store = new WorkbenchStore("user", browser, null, () => {})
    const source = store.frames()[0]!.id
    const picture = "/picture?media=synthetic&name=Portrait&crop=100_100_5000_5000"
    store.dropOpen(picture, source, zone)
    const id = focusedTab(store.layout)!.id
    const target = store.frameOf(id)!
    const before = zone === "left" || zone === "top"
    expect(store.frames().map((frame) => frame.id)).toEqual(before ? [target, source] : [source, target])
    expect(store.layout.root.type === "split" && store.layout.root.direction).toBe(
      zone === "left" || zone === "right" ? "row" : "column"
    )
    expect(browser.location.href).toBe(picture)
    store.closeFrame(source)
    expect(store.frames()).toHaveLength(1)
    expect(focusedTab(store.layout)?.href).toBe(picture)
    store.split(target, "row")
    const copy = focusedTab(store.layout)!.id
    const destination = store.frameOf(copy)!
    // A different item in the new frame lets the picture move there without a twin.
    store.open("/chats/b", { frame: destination })
    store.close(copy)
    store.move(id, destination)
    expect(store.frames()).toHaveLength(1)
    expect(store.frames()[0]!.id).toBe(destination)
    const restored = new WorkbenchStore("user", browser, saveLayout(store.layout), () => {})
    expect(restored.frames()[0]!.tabs.map((tab) => tab.href)).toEqual(["/chats/b", picture])
    expect(focusedTab(restored.layout)?.href).toBe(picture)
    restored.close(id)
    expect(focusedTab(restored.layout)?.href).toBe("/chats/b")
    vi.runAllTimers()
  }
)

it("releases closed tabs' metadata, deferred history and unsaved state", () => {
  vi.useFakeTimers()
  const store = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/home"] }), null, () => {})
  store.pin(focusedTab(store.layout)!.id)
  for (let i = 0; i < 100; i++) {
    const id = store.open(`/item/${i}`, { preview: false, state: { reading: i } })
    store.setMeta(id, { title: `Item ${i}`, decoration: { key: `${i}`, node: "picture" } })
    store.setUnsaved(id, true)
    store.close(id)
  }
  const retained = store as unknown as {
    meta: Map<string, unknown>
    initialState: Map<string, unknown>
    openedFrom: Map<string, unknown>
    unsavedTabs: Set<string>
  }
  expect(retained.meta.size).toBe(0)
  expect(retained.initialState.size).toBeLessThanOrEqual(1)
  expect(retained.openedFrom.size).toBe(0)
  expect(retained.unsavedTabs.size).toBe(0)
  vi.runAllTimers()
})

it("an editor's panel follows its source view when the same chat is open twice", () => {
  vi.useFakeTimers()
  const store = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/chats/a"] }), null, () => {})
  const first = focusedTab(store.layout)!.id
  store.pin(first)
  const frame = store.frames()[0]!.id
  store.split(frame, "row")
  const second = focusedTab(store.layout)!.id
  const removeFirst = store.addPanelTab(first)
  const removeSecond = store.addPanelTab(second)
  store.open(`/library/p?chat=a&chatTab=${second}`, { frame, preview: false })
  expect(store.panelOwner(true)).toBe(second)
  removeSecond()
  expect(store.panelOwner(true)).toBe(first)
  removeFirst()
  vi.runAllTimers()
})
