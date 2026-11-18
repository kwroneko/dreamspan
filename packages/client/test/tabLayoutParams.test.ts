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
import { decodeChoices, encodeChoices } from "../src/ui/openBlocks.ts"
import { decodeOpen, encodeOpen } from "../src/features/editor/lorebookOpen.ts"

const off: Array<() => void> = []
afterEach(() => {
  for (const stop of off.splice(0)) stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const register = (keys: ReadonlyArray<string>) => off.push(layoutParams.register({ id: `test.${keys.join()}`, keys }))

it("writes a layout param into the browser's URL, replacing its entry, and removes it at the default", () => {
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

it("follows the URL: Back to an entry with another value reads that value", () => {
  const history = createMemoryHistory({ initialEntries: ["/a?sbw=300", "/b?sbw=410"], initialIndex: 1 })
  setLayoutHistory(history)
  expect(readLayoutParam("sbw")).toBe("410")
  history.back()
  expect(readLayoutParam("sbw")).toBe("300")
})

it("a held drag shows its values at once and writes the URL once, when it ends", () => {
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

it("encodes a list's block choices, open by id and closed as !id, absent when none", () => {
  const choices = new Map([
    ["a", true],
    ["b", false]
  ])
  expect(encodeChoices(choices)).toEqual(["a", "!b"])
  expect(decodeChoices(["a", "!b", 3, "", "!"])).toEqual(choices)
  expect(encodeChoices(new Map())).toBeUndefined()
  expect(decodeChoices("junk")).toEqual(new Map())
})

it("encodes a lorebook view's open entries as uids, absent when none", () => {
  expect(encodeOpen(new Set([3, 9]))).toEqual([3, 9])
  expect(encodeOpen(new Set())).toBeUndefined()
  expect(decodeOpen([3, "9", "x", 1.5])).toEqual(new Set([3, 9]))
  expect(decodeOpen(undefined)).toEqual(new Set())
})
