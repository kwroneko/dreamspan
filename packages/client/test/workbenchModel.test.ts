// The center column's frames and tabs (features/workbench/model.ts): VS Code's preview tabs,
// one tab per item in a frame, splits that copy the shown tab and collapse when emptied, and saved layouts repaired on read.
import { describe, expect, it } from "vitest"
import {
  allTabs,
  closeTab,
  focusFrame,
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

  it("splits with a kept copy of the shown tab, as VS Code's Split Editor does", () => {
    let layout = initialLayout("/a")
    const first = focusedFrame(layout).id
    layout = splitFrame(layout, first, "row")
    expect(titles(layout)).toEqual([["/a"], ["/a"]])
    expect(focusedFrame(layout).id).not.toBe(first)
    expect(focusedTab(layout)?.preview).toBe(false)
    // Each frame's own tab of the item: the focused frame's is the one opened.
    const copy = focusedTab(layout)!.id
    layout = openTab(layout, "/a?fork=x", keyOf)
    expect(focusedTab(layout)?.id).toBe(copy)
    expect(titles(layout)).toEqual([["/a"], ["/a"]])
    layout = openTab(layout, "/b", keyOf)
    expect(titles(layout)).toEqual([["/a"], ["/a", "/b"]])
    expect(neighbours(layout, first).right).toBe(focusedFrame(layout).id)
    expect([...leftEdgeFrames(layout.root)]).toEqual([first])
  })

  it("opens an item another frame shows there, unless a frame is named", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    const first = focusedFrame(layout).id
    layout = splitFrame(layout, first, "row")
    layout = openTab(layout, "/b", keyOf, { preview: false })
    layout = focusFrame(layout, first)
    layout = openTab(layout, "/b", keyOf)
    expect(titles(layout)).toEqual([["/a"], ["/a", "/b"]])
    expect(focusedFrame(layout).id).not.toBe(first)
    layout = openTab(layout, "/b", keyOf, { frame: first })
    expect(titles(layout)).toEqual([
      ["/a", "/b"],
      ["/a", "/b"]
    ])
    expect(focusedFrame(layout).id).toBe(first)
  })

  it("closes a frame with its last tab, back to one frame", () => {
    let layout = initialLayout("/a")
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    layout = closeTab(layout, focusedTab(layout)!.id)
    expect(layout.root.type).toBe("frame")
    expect(titles(layout)).toEqual([["/a"]])
  })

  it("moves a tab between frames; a frame with the item keeps its own", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    layout = openTab(layout, "/b", keyOf, { preview: false })
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    expect(titles(layout)).toEqual([["/a", "/b"], ["/b"]])
    const [left] = frames(layout.root)
    layout = openTab(layout, "/c", keyOf, { preview: false })
    layout = moveTab(layout, focusedTab(layout)!.id, left!.id, undefined, keyOf)
    expect(titles(layout)).toEqual([["/a", "/b", "/c"], ["/b"]])
    const right = frames(layout.root)[1]!
    layout = moveTab(layout, right.tabs[0]!.id, left!.id, undefined, keyOf)
    expect(titles(layout)).toEqual([["/a", "/b", "/c"]])
    expect(focusedTab(layout)?.href).toBe("/b")
  })

  it("splits empty on either side, for a tab dropped on a frame's edge", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    layout = openTab(layout, "/b", keyOf, { preview: false })
    const frame = focusedFrame(layout).id
    layout = splitFrame(layout, frame, "column", { newFrameId: "top", before: true, empty: true })
    layout = moveTab(layout, focusedTab(layout)?.id ?? allTabs(layout)[1]!.id, "top", undefined, keyOf)
    expect(titles(layout)).toEqual([["/b"], ["/a"]])
    expect(layout.root.type === "split" && layout.root.direction).toBe("column")
  })

  it("keeps one row of three, not a row inside a row", () => {
    let layout = initialLayout("/a")
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
    layout = splitFrame(layout, focusedFrame(layout).id, "row")
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
    expect(
      restoreLayout({ version: 1, root: { type: "frame", id: "f", tabs: [{ id: "t", href: "https://x" }] } })
    ).toBeNull()
    const broken = restoreLayout({
      version: 1,
      root: {
        type: "split",
        id: "s",
        direction: "row",
        sizes: [1, "x"],
        children: [saved.root, { type: "frame", id: "e", tabs: [] }]
      }
    })
    expect(broken && titles(broken)).toEqual(titles(layout))
  })
})
