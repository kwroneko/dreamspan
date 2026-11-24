// Each tab's own back and forward (spec/TAB-HISTORY.md): the model, its storage, and the store's
// steps, the browser's Back and a reload.
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  decodeHistory,
  decodeOrder,
  destination,
  encodeHistory,
  freshHistory,
  go,
  matchSaved,
  MAX_ENTRIES,
  push,
  replace,
  type TabHistory
} from "../src/features/workbench/history.ts"
import { allTabs, findTab, focusedTab, frameOfTab, saveLayout } from "../src/features/workbench/model.ts"
import { WorkbenchStore } from "../src/features/workbench/store.ts"

const hrefs = (history: TabHistory) => history.entries.map((e) => e.href)

describe("the model", () => {
  it("steps forward, back and forward again; new navigation clears forward", () => {
    let h = freshHistory("/a")
    h = push(h, { href: "/b" })
    h = push(h, { href: "/c" })
    expect(hrefs(h)).toEqual(["/a", "/b", "/c"])
    h = go(h, -1)
    expect(destination(h, -1)?.href).toBe("/a")
    expect(destination(h, 1)?.href).toBe("/c")
    h = push(h, { href: "/d" })
    expect(hrefs(h)).toEqual(["/a", "/b", "/d"])
    expect(destination(h, 1)).toBeUndefined()
    // Past either end nothing moves.
    expect(go(h, 1)).toBe(h)
    expect(go(go(go(h, -1), -1), -1).index).toBe(0)
  })

  it("a replace updates the entry shown and keeps what was taken when it was left", () => {
    let h = push(freshHistory("/?q=e"), { href: "/chats/a" })
    h = go({ ...h, entries: [{ ...h.entries[0]!, label: "cardex search: e", scroll: [] }, h.entries[1]!] }, -1)
    h = replace(h, { href: "/?q=elf" })
    expect(h.entries).toHaveLength(2)
    expect(h.entries[0]).toEqual({ href: "/?q=elf", label: "cardex search: e", scroll: [] })
  })

  it("a step to the URL shown replaces it rather than adding a second entry", () => {
    const h = push(freshHistory("/a"), { href: "/a", state: { reading: 1 } })
    expect(h.entries).toEqual([{ href: "/a", state: { reading: 1 } }])
  })

  it(`keeps at most ${MAX_ENTRIES} entries, the oldest dropped`, () => {
    let h = freshHistory("/0", "/opener")
    for (let i = 1; i <= 60; i++) h = push(h, { href: `/${i}` })
    expect(h.entries).toHaveLength(MAX_ENTRIES)
    expect(h.entries.at(-1)?.href).toBe("/60")
    expect(h.entries[0]?.href).toBe("/11")
    expect(h.index).toBe(MAX_ENTRIES - 1)
    expect(h.floor).toBe(0)
  })

  it("never steps back to the opener's entry: the floor", () => {
    const h = freshHistory("/import", "/chats/a")
    expect(hrefs(h)).toEqual(["/chats/a", "/import"])
    expect(destination(h, -1)).toBeUndefined()
    expect(go(h, -1)).toBe(h)
  })

  it("round-trips through storage without TanStack's keys; anything else is refused or repaired", () => {
    const h: TabHistory = {
      entries: [
        { href: "/?q=elf", scroll: [{ path: [0, 2], what: "div", top: 900, left: 0 }], label: "cardex search: elf" },
        { href: "/chats/a", state: { reading: 3, __TSR_key: "k", __TSR_index: 1, key: "k" } }
      ],
      index: 1,
      floor: 0
    }
    const back = decodeHistory(encodeHistory(h))
    expect(back).toEqual({
      entries: [h.entries[0], { href: "/chats/a", state: { reading: 3 } }],
      index: 1,
      floor: 0
    })
    expect(decodeHistory(null)).toBeNull()
    expect(decodeHistory("{")).toBeNull()
    expect(decodeHistory(JSON.stringify({ v: 2, entries: [{ href: "/" }], index: 0, floor: 0 }))).toBeNull()
    // Outside the app, or the index on a bad entry: refused.
    expect(decodeHistory(JSON.stringify({ v: 1, entries: [{ href: "//evil.example" }], index: 0 }))).toBeNull()
    // A bad entry before the one shown is dropped, the index following.
    const repaired = decodeHistory(
      JSON.stringify({ v: 1, entries: [{ href: "https://x.example/" }, { href: "/a" }, { href: "/b" }], index: 2 })
    )
    expect(repaired && { hrefs: hrefs(repaired), index: repaired.index }).toEqual({ hrefs: ["/a", "/b"], index: 1 })
    // State that isn't JSON isn't written.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(encodeHistory({ entries: [{ href: "/", state: cyclic }], index: 0, floor: 0 })).toBeNull()
  })

  it("matches saved histories to restored tabs by item, in layout order", () => {
    const key = (href: string) => href.split("?")[0]!
    const saved = [
      ["old1", "/"],
      ["old2", "/chats/a"],
      ["old3", "/chats/b"],
      ["old4", "/chats/a"]
    ] as const
    const tabs = [
      { id: "n1", href: "/chats/a?fork=x" },
      { id: "n2", href: "/chats/b" },
      { id: "n3", href: "/chats/a" },
      { id: "n4", href: "/chats/c" }
    ]
    expect([...matchSaved(saved, tabs, key)]).toEqual([
      ["n1", "old2"],
      ["n2", "old3"],
      ["n3", "old4"]
    ])
    expect(decodeOrder(JSON.stringify(saved))).toEqual(saved)
    expect(decodeOrder('[[1,2],["a","/"]]')).toEqual([["a", "/"]])
    expect(decodeOrder("x")).toEqual([])
  })
})

/** Session storage for one browser tab. */
class MemoryStorage {
  readonly values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

let storage: MemoryStorage
beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal("sessionStorage", storage)
  vi.stubGlobal("window", new EventTarget())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A tab's view as TabHost mounts it: its history, attached, with the store's blocker. */
const mount = (store: WorkbenchStore, tabId: string) => {
  const history = store.createHistory(tabId, () => [])
  const detach = store.attach(tabId, history)
  const unblock = history.block({
    blockerFn: ({ nextLocation, action }) => store.leaves(tabId, nextLocation.href, nextLocation.state, action),
    enableBeforeUnload: false
  })
  return {
    history,
    stop: () => {
      unblock()
      detach()
    }
  }
}
/** A push through the blocker settles after a microtask or two. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const pushIn = async (history: RouterHistory, href: string) => {
  history.push(href)
  await settle()
}

const startStore = (href: string, saved: unknown = null, save: (layout: unknown) => void = () => {}) => {
  const browser = createMemoryHistory({ initialEntries: [href] })
  const store = new WorkbenchStore("user", browser, saved, save, () => true)
  const stop = store.start()
  return { browser, store, stop }
}

describe("the store", () => {
  it("a preview tab following a link to another item takes a step; ← and → walk it", async () => {
    const { browser, store, stop } = startStore("/")
    const tab = focusedTab(store.layout)!.id
    const view = mount(store, tab)
    store.setMeta(tab, { title: "Characters" })
    store.setPlace(tab, "cardex search: elf")
    // Typing in the search replaces the entry: no step.
    view.history.replace("/?q=elf")
    await settle()
    expect(store.stepLabel(tab, -1)).toBeNull()
    await pushIn(view.history, "/chats/a")
    expect(findTab(store.layout, tab)?.href).toBe("/chats/a")
    store.setMeta(tab, { title: "Mara" })
    expect(store.stepLabel(tab, -1)).toBe("cardex search: elf")
    expect(store.stepLabel(tab, 1)).toBeNull()
    const browserLength = browser.length

    store.step(tab, -1)
    expect(findTab(store.layout, tab)?.href).toBe("/?q=elf")
    expect(browser.location.href).toBe("/?q=elf")
    // The browser's entry is replaced, not pushed: its Back is as it was.
    expect(browser.length).toBe(browserLength)
    expect(store.stepLabel(tab, 1)).toBe("Mara")
    expect(store.stepLabel(tab, -1)).toBeNull()

    store.step(tab, 1)
    expect(findTab(store.layout, tab)?.href).toBe("/chats/a")
    view.stop()
    stop()
  })

  it("the next card replacing a preview tab beside is a step in that tab", async () => {
    const { store, stop } = startStore("/")
    const home = focusedTab(store.layout)!.id
    const homeView = mount(store, home)
    const side = store.openBeside("/sources/cardex/cards/1", { preview: true })
    const sideView = mount(store, side)
    store.setMeta(side, { title: "Ash" })
    expect(store.openBeside("/sources/cardex/cards/2", { preview: true })).toBe(side)
    expect(store.stepLabel(side, -1)).toBe("Ash")
    // The other frame's tab is untouched.
    expect(store.stepLabel(home, -1)).toBeNull()
    store.step(side, -1)
    expect(findTab(store.layout, side)?.href).toBe("/sources/cardex/cards/1")
    expect(focusedTab(store.layout)?.id).toBe(side)
    sideView.stop()
    homeView.stop()
    stop()
  })

  it("a new tab starts its own history; a moved tab keeps its own", async () => {
    const { store, stop } = startStore("/chats/a")
    const a = focusedTab(store.layout)!.id
    const aView = mount(store, a)
    await pushIn(aView.history, "/chats/a?fork=2")
    expect(store.stepLabel(a, -1)).not.toBeNull()
    // Split: the copy is a new tab, with nothing to go back to.
    store.split(store.frameOf(a)!, "row")
    const copy = focusedTab(store.layout)!.id
    const copyView = mount(store, copy)
    expect(copy).not.toBe(a)
    expect(store.stepLabel(copy, -1)).toBeNull()
    // Opened from another tab: the opener's entry is below the arrows' floor, but the page's own
    // Back still reaches it.
    const imported = store.open("/import", { preview: false })
    const importView = mount(store, imported)
    expect(store.stepLabel(imported, -1)).toBeNull()
    expect(importView.history.location.href).toBe("/import")
    expect(importView.history.canGoBack()).toBe(true)
    // Moving a tab to a frame of its own keeps its history.
    const was = store.frameOf(a)
    store.moveToSplit(a, "column", store.frameOf(copy))
    expect(store.frameOf(a)).toBeDefined()
    expect(store.frameOf(a)).not.toBe(was)
    expect(store.stepLabel(a, -1)).not.toBeNull()
    importView.stop()
    copyView.stop()
    aView.stop()
    stop()
  })

  it("stepping to an item another tab of the frame shows reveals that tab", async () => {
    const { store, stop } = startStore("/")
    const tab = focusedTab(store.layout)!.id
    const view = mount(store, tab)
    await pushIn(view.history, "/chats/a")
    // Home opened again, kept, beside it in the same frame.
    store.pin(tab)
    const home = store.open("/", { preview: false })
    expect(home).not.toBe(tab)
    store.focusTab(tab)
    store.step(tab, -1)
    expect(focusedTab(store.layout)?.id).toBe(home)
    expect(findTab(store.layout, tab)?.href).toBe("/chats/a")
    expect(frameOfTab(store.layout, tab)?.tabs).toHaveLength(2)
    view.stop()
    stop()
  })

  it("the browser's Back to the tab's entry before moves the tab there rather than writing over it", async () => {
    const { browser, store, stop } = startStore("/")
    const tab = focusedTab(store.layout)!.id
    const view = mount(store, tab)
    await pushIn(view.history, "/?show=src.cardex")
    expect(browser.location.href).toBe("/?show=src.cardex")
    browser.back()
    expect(browser.location.href).toBe("/")
    expect(findTab(store.layout, tab)?.href).toBe("/")
    // The tab's Forward is the place Back left.
    expect(store.stepLabel(tab, 1)).not.toBeNull()
    expect(store.stepLabel(tab, -1)).toBeNull()
    browser.forward()
    expect(findTab(store.layout, tab)?.href).toBe("/?show=src.cardex")
    expect(store.stepLabel(tab, -1)).not.toBeNull()
    view.stop()
    stop()
  })

  it.each(["forward", "go"] as const)("browser %s restores the later visit to the same URL", async (action) => {
    const cardex = "/?show=src.cardex"
    const { browser, store, stop } = startStore(cardex)
    const tab = focusedTab(store.layout)!.id
    const view = mount(store, tab)
    try {
      await pushIn(view.history, "/")
      view.history.push(cardex, { visit: 2 })
      await settle()
      browser.back()
      expect(view.history.location.href).toBe("/")
      if (action === "forward") browser.forward()
      else browser.go(1)
      expect(view.history.location.href).toBe(cardex)
      expect(store.shownEntry(tab)?.state?.visit).toBe(2)
      expect(store.stepLabel(tab, 1)).toBeNull()
    } finally {
      view.stop()
      stop()
    }
  })

  it("a reload gives each tab its history back from session storage; closing a tab drops it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let saved: unknown = null
    const first = startStore("/", null, (layout) => {
      saved = saveLayout(layout as never)
    })
    const tab = focusedTab(first.store.layout)!.id
    const view = mount(first.store, tab)
    first.store.setMeta(tab, { title: "Characters" })
    view.history.push("/chats/a")
    await vi.advanceTimersByTimeAsync(1)
    const other = first.store.openBeside("/chats/b")
    const otherView = mount(first.store, other)
    window.dispatchEvent(new Event("pagehide"))
    const keys = [...storage.values.keys()]
    expect(keys).toContain(`dreamspan.tabHistory.user.${tab}`)
    expect(keys).toContain("dreamspan.tabHistory.user.order")
    otherView.stop()
    view.stop()
    first.stop()

    // Ids are made afresh (layoutParam.ts): the restored tabs are matched by item, in order.
    const fresh = JSON.parse(JSON.stringify(saved).replaceAll(tab, "renamed1").replaceAll(other, "renamed2")) as unknown
    const second = startStore("/chats/b", fresh)
    const restored = allTabs(second.store.layout).find((t) => t.href === "/chats/a")!
    expect(restored.id).toBe("renamed1")
    const again = mount(second.store, restored.id)
    expect(second.store.stepLabel(restored.id, -1)).toBe("Characters")
    expect(again.history.location.href).toBe("/chats/a")
    // The old ids' keys are gone.
    expect(storage.values.has(`dreamspan.tabHistory.user.${tab}`)).toBe(false)
    second.store.close(restored.id)
    await vi.advanceTimersByTimeAsync(500)
    expect([...storage.values.keys()].some((key) => key.endsWith(".renamed1"))).toBe(false)
    again.stop()
    second.stop()
  })

  it("works without session storage, for as long as the page lasts", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
      key: () => null,
      length: 0
    })
    const { store, stop } = startStore("/")
    const tab = focusedTab(store.layout)!.id
    const view = mount(store, tab)
    store.setMeta(tab, { title: "Characters" })
    await pushIn(view.history, "/chats/a")
    window.dispatchEvent(new Event("pagehide"))
    expect(store.stepLabel(tab, -1)).toBe("Characters")
    view.stop()
    stop()
  })
})
