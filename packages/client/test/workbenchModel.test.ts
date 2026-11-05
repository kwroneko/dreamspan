// The center column's frames and tabs (features/workbench/model.ts): VS Code's preview tabs,
// one tab per item, splits that collapse when emptied, and saved layouts repaired on read.
import { describe, expect, it } from "vitest"
import {
  allTabs,
  closeTab,
  focusedFrame,
  focusedTab,
  frames,
  initialLayout,
  type Layout,
  leftEdgeFrames,
  moveTab,
  neighbours,
  openTab,
  pinTab,
  restoreLayout,
  saveLayout,
  splitFrame
} from "../src/features/workbench/model.ts"

const keyOf = (href: string) => href.split("?")[0]!
const titles = (layout: Layout) => frames(layout.root).map((f) => f.tabs.map((t) => keyOf(t.href)))

describe("workbench layout", () => {
  it("replaces the preview tab with the next single-click open", () => {
    let layout = initialLayout("/chats/a")
    layout = openTab(layout, "/chats/b", keyOf)
    expect(titles(layout)).toEqual([["/chats/b"]])
    expect(focusedTab(layout)?.preview).toBe(true)
  })

  it("adds a tab beside a kept one, and focuses an item already open", () => {
    let layout = initialLayout("/chats/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    layout = openTab(layout, "/chats/b", keyOf)
    expect(titles(layout)).toEqual([["/chats/a", "/chats/b"]])
    layout = openTab(layout, "/chats/a?fork=x", keyOf)
    expect(titles(layout)).toEqual([["/chats/a", "/chats/b"]])
    expect(focusedTab(layout)?.href).toBe("/chats/a?fork=x")
  })

  it("keeps a tab opened with a double click", () => {
    let layout = initialLayout("/chats/a")
    layout = openTab(layout, "/chats/b", keyOf, { preview: false })
    expect(focusedTab(layout)?.preview).toBe(false)
    expect(titles(layout)).toEqual([["/chats/b"]])
  })

  it("returns to the tab focused before when one closes", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    layout = openTab(layout, "/b", keyOf, { preview: false })
    layout = openTab(layout, "/c", keyOf, { preview: false })
    const b = allTabs(layout).find((t) => t.href === "/b")!
    const c = allTabs(layout).find((t) => t.href === "/c")!
    layout = closeTab(openTab(layout, "/b", keyOf), b.id)
    expect(focusedTab(layout)?.id).toBe(c.id)
  })

  it("splits off the shown tab, or an empty frame for a single tab", () => {
    let layout = initialLayout("/a")
    const first = focusedFrame(layout).id
    layout = splitFrame(layout, first, "row")
    expect(titles(layout)).toEqual([["/a"], []])
    expect(focusedFrame(layout).tabs).toEqual([])
    layout = openTab(layout, "/b", keyOf)
    expect(titles(layout)).toEqual([["/a"], ["/b"]])
    expect(neighbours(layout, first).right).toBe(focusedFrame(layout).id)
    expect([...leftEdgeFrames(layout.root)]).toEqual([first])
  })

  it("closes a frame with its last tab, back to one frame", () => {
    let layout = initialLayout("/a")
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    layout = openTab(layout, "/b", keyOf)
    layout = closeTab(layout, focusedTab(layout)!.id)
    expect(layout.root.type).toBe("frame")
    expect(titles(layout)).toEqual([["/a"]])
  })

  it("moves a tab between frames, closing the frame it left empty", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    layout = openTab(layout, "/b", keyOf, { preview: false })
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    expect(titles(layout)).toEqual([["/a"], ["/b"]])
    const [left] = frames(layout.root)
    layout = moveTab(layout, focusedTab(layout)!.id, left!.id)
    expect(titles(layout)).toEqual([["/a", "/b"]])
  })

  it("keeps one row of three, not a row inside a row", () => {
    let layout = initialLayout("/a")
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    layout = openTab(layout, "/b", keyOf)
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    layout = openTab(layout, "/c", keyOf)
    expect(layout.root.type === "split" && layout.root.children.length).toBe(3)
    const sizes = layout.root.type === "split" ? layout.root.sizes : []
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it("saves and restores, repairing what it can't use", () => {
    let layout = initialLayout("/a")
    layout = splitFrame(layout, focusedFrame(layout).id, "column")
    layout = openTab(layout, "/b", keyOf)
    const saved = JSON.parse(JSON.stringify(saveLayout(layout)))
    const restored = restoreLayout(saved)!
    expect(titles(restored)).toEqual(titles(layout))
    expect(restored.focused).toBe(layout.focused)
    expect(restoreLayout({ version: 2 })).toBeNull()
    expect(restoreLayout({ version: 1, root: { type: "frame", id: "f", tabs: [{ id: "t", href: "https://x" }] } })).toBeNull()
    const broken = restoreLayout({
      version: 1,
      root: { type: "split", id: "s", direction: "row", sizes: [1, "x"], children: [saved.root, { type: "frame", id: "e", tabs: [] }] }
    })
    expect(broken && titles(broken)).toEqual(titles(layout))
  })
})
