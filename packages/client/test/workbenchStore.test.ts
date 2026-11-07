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
