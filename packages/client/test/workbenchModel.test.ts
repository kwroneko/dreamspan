// The center column's frames and tabs (features/workbench/model.ts): VS Code's preview tabs,
// one tab per item in a frame, splits that copy the shown tab and collapse when emptied, and saved layouts repaired on read.
import { describe, expect, it } from "vitest"
import {
  allTabs,
  closeTab,
  closeTabs,
  focusFrame,
  focusedFrame,
  focusedTab,
  frameBoxes,
  frames,
  hasRoom,
  initialLayout,
  type Layout,
  maximizeFrame,
  MIN_FRAME_HEIGHT,
  MIN_FRAME_WIDTH,
  minSize,
  moveTab,
  neighbours,
  openTab,
  pinTab,
  restoreLayout,
  saveLayout,
  showsStrips,
  splitFrame,
  stickTab,
  stripCorners
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
    expect(stripCorners(layout)).toEqual({ topLeft: first, topRight: focusedFrame(layout).id })
    expect(showsStrips(layout)).toBe(true)
  })

  it("puts the shell's strip buttons on the top-left and top-right frames", () => {
    let layout = initialLayout("/a")
    const only = focusedFrame(layout).id
    expect(showsStrips(layout)).toBe(false)
    expect(stripCorners(layout)).toEqual({ topLeft: only, topRight: only })
    layout = openTab(pinTab(layout, focusedTab(layout)!.id), "/b", keyOf)
    expect(showsStrips(layout)).toBe(true)
    // Left | (top-right over bottom-right): the right column's top frame takes the panel's toggle.
    layout = splitFrame(layout, only, "row")
    const right = focusedFrame(layout).id
    layout = splitFrame(layout, right, "column")
    const bottomRight = focusedFrame(layout).id
    expect(stripCorners(layout)).toEqual({ topLeft: only, topRight: right })
    // Over a left column split in two, the top one has the sidebar's button.
    layout = splitFrame(focusFrame(layout, only), only, "column")
    expect(stripCorners(layout).topLeft).toBe(only)
    // A maximized frame shows alone and carries both.
    layout = maximizeFrame(layout, bottomRight)
    expect(stripCorners(layout)).toEqual({ topLeft: bottomRight, topRight: bottomRight })
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

  it("uses the strip's insertion boundary when reordering to the right", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    for (const href of ["/b", "/c"]) layout = openTab(layout, href, keyOf, { preview: false })
    layout = moveTab(layout, allTabs(layout)[0]!.id, focusedFrame(layout).id, 2)
    expect(titles(layout)).toEqual([["/b", "/a", "/c"]])
  })

  it("keeps moved tabs open without crossing the pinned boundary", () => {
    let layout = initialLayout("/a")
    const a = focusedTab(layout)!.id
    layout = stickTab(layout, a, true)
    const left = focusedFrame(layout).id
    layout = splitFrame(layout, left, "row")
    layout = openTab(layout, "/b", keyOf)
    const b = focusedTab(layout)!.id
    layout = openTab(layout, "/c", keyOf, { frame: left })
    layout = moveTab(layout, b, left, 0, keyOf)
    expect(titles(layout)).toEqual([["/a", "/b", "/c"], ["/a"]])
    expect(allTabs(layout).find((t) => t.id === b)?.preview).toBe(false)
    layout = moveTab(layout, a, left, 3, keyOf)
    expect(titles(layout)[0]).toEqual(["/a", "/b", "/c"])
    layout = openTab(layout, "/d", keyOf)
    expect(titles(layout)[0]).toEqual(["/a", "/b", "/d"])
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

  it("pins tabs first; Close others, to the right, saved and all keep them", () => {
    let layout = initialLayout("/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    for (const href of ["/b", "/c", "/d"]) layout = openTab(layout, href, keyOf, { preview: false })
    const id = (href: string) => allTabs(layout).find((t) => t.href === href)!.id
    layout = stickTab(layout, id("/c"), true)
    expect(titles(layout)).toEqual([["/c", "/a", "/b", "/d"]])
    expect(closeTabs(layout, id("/b"), "right").root).toMatchObject({
      tabs: [{ href: "/c" }, { href: "/a" }, { href: "/b" }]
    })
    expect(titles(closeTabs(layout, id("/a"), "others"))).toEqual([["/c", "/a"]])
    expect(titles(closeTabs(layout, id("/a"), "all"))).toEqual([["/c"]])
    expect(titles(closeTabs(layout, id("/a"), "saved", (tabId) => tabId === id("/d")))).toEqual([["/c", "/d"]])
    layout = stickTab(layout, id("/c"), false)
    expect(titles(layout)).toEqual([["/c", "/a", "/b", "/d"]])
    expect(
      allTabs(restoreLayout(JSON.parse(JSON.stringify(saveLayout(stickTab(layout, id("/d"), true)))))!).find(
        (t) => t.href === "/d"
      )?.sticky
    ).toBe(true)
  })

  it("maximizes a frame until another frame is focused", () => {
    let layout = initialLayout("/a")
    const first = focusedFrame(layout).id
    layout = splitFrame(layout, first, "row")
    const second = focusedFrame(layout).id
    layout = maximizeFrame(layout, second)
    expect(layout.maximized).toBe(second)
    layout = openTab(layout, "/b", keyOf)
    expect(layout.maximized).toBe(second)
    layout = focusFrame(layout, first)
    expect(layout.maximized).toBeUndefined()
    expect(maximizeFrame(initialLayout("/a"), "x").maximized).toBeUndefined()
    expect(saveLayout(maximizeFrame(layout, first))).not.toHaveProperty("maximized")
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

  it("drops network-path URLs and repairs saved pinned and preview order", () => {
    for (const href of ["//other.invalid/chats/a", "/\\other.invalid/chats/a"]) {
      expect(restoreLayout({ version: 1, root: { type: "frame", id: "f", tabs: [{ id: "t", href }] } })).toBeNull()
    }
    const restored = restoreLayout({
      version: 1,
      root: {
        type: "frame",
        id: "f",
        tabs: [
          { id: "a", href: "/a", preview: true },
          { id: "b", href: "/b", sticky: true },
          { id: "c", href: "/c", preview: true }
        ]
      }
    })!
    expect(titles(restored)).toEqual([["/b", "/a", "/c"]])
    expect(allTabs(restored).filter((tab) => tab.preview)).toHaveLength(1)
  })
})

// Kind affinity (owner, 2026-11-23): the request inspector opens where an inspector is showing.
describe("kind affinity", () => {
  const affinity = (href: string) => (href.includes("/context/") ? "request" : null)
  /** A kept chat on the left, an inspector of `first` beside it; focus back on the chat. */
  const chatAndInspector = (first: string, keep = false) => {
    let layout = initialLayout("/chats/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    const chatFrame = focusedFrame(layout).id
    layout = splitFrame(layout, chatFrame, "row", { empty: true })
    const inspectorFrame = focusedFrame(layout).id
    layout = openTab(layout, first, keyOf, { frame: inspectorFrame, preview: !keep })
    return { layout: focusFrame(layout, chatFrame), chatFrame, inspectorFrame }
  }

  it("replaces the italic inspector beside the chat, which keeps its frame", () => {
    const { layout: start, chatFrame, inspectorFrame } = chatAndInspector("/chats/a/context/1")
    const layout = openTab(start, "/chats/a/context/2", keyOf, { frame: chatFrame, affinity })
    expect(titles(layout)).toEqual([["/chats/a"], ["/chats/a/context/2"]])
    expect(focusedFrame(layout).id).toBe(inspectorFrame)
    expect(focusedTab(layout)?.preview).toBe(true)
  })

  it("opens a new italic tab beside a kept inspector", () => {
    const { layout: start, chatFrame } = chatAndInspector("/chats/a/context/1", true)
    const layout = openTab(start, "/chats/a/context/2", keyOf, { frame: chatFrame, affinity })
    expect(titles(layout)).toEqual([["/chats/a"], ["/chats/a/context/1", "/chats/a/context/2"]])
    expect(focusedTab(layout)?.preview).toBe(true)
  })

  it("doesn't count an inspector hidden behind another tab", () => {
    const { layout: start, chatFrame, inspectorFrame } = chatAndInspector("/chats/a/context/1", true)
    // The inspector's frame now shows a chat in front of it.
    const covered = focusFrame(openTab(start, "/chats/b", keyOf, { frame: inspectorFrame }), chatFrame)
    const layout = openTab(covered, "/chats/a/context/2", keyOf, { frame: chatFrame, affinity })
    expect(titles(layout)).toEqual([
      ["/chats/a", "/chats/a/context/2"],
      ["/chats/a/context/1", "/chats/b"]
    ])
    expect(focusedFrame(layout).id).toBe(chatFrame)
  })

  it("picks the most recently focused of two frames showing inspectors", () => {
    const { layout: start, chatFrame, inspectorFrame } = chatAndInspector("/chats/a/context/1", true)
    let layout = splitFrame(start, inspectorFrame, "row", { empty: true })
    const second = focusedFrame(layout).id
    layout = openTab(layout, "/chats/a/context/9", keyOf, { frame: second, preview: false })
    // The first inspector's frame was focused after the second's.
    const firstLater = focusFrame(focusFrame(layout, inspectorFrame), chatFrame)
    const next = openTab(firstLater, "/chats/a/context/2", keyOf, { frame: chatFrame, affinity })
    expect(titles(next)).toEqual([["/chats/a"], ["/chats/a/context/1", "/chats/a/context/2"], ["/chats/a/context/9"]])
    expect(focusedFrame(next).id).toBe(inspectorFrame)
    // And the other way round.
    const secondLater = focusFrame(focusFrame(firstLater, second), chatFrame)
    const other = openTab(secondLater, "/chats/a/context/2", keyOf, { frame: chatFrame, affinity })
    expect(titles(other)).toEqual([["/chats/a"], ["/chats/a/context/1"], ["/chats/a/context/9", "/chats/a/context/2"]])
    expect(focusedFrame(other).id).toBe(second)
  })

  it("opens as before when no frame shows an inspector", () => {
    let layout = initialLayout("/chats/a")
    layout = pinTab(layout, focusedTab(layout)!.id)
    const plain = openTab(layout, "/chats/a/context/2", keyOf, { id: "t" })
    const affine = openTab(layout, "/chats/a/context/2", keyOf, { id: "t", affinity })
    expect(affine).toEqual(plain)
    expect(titles(plain)).toEqual([["/chats/a", "/chats/a/context/2"]])
  })

  it("leaves items of kinds without an affinity where they open", () => {
    const { layout: start, chatFrame } = chatAndInspector("/chats/a/context/1")
    const layout = openTab(start, "/chats/b", keyOf, { frame: chatFrame, affinity })
    expect(titles(layout)).toEqual([["/chats/a", "/chats/b"], ["/chats/a/context/1"]])
  })
})

// Per-open affinity (spec/WORKSHOP-CARDS.md §7.3): a workshop's change row opens the card, or its
// change view, where a card editor is shown beside the chat, without making every card open so.
describe("per-open affinity", () => {
  const editor = (href: string) => /^\/library\/[^/]+$/.test(keyOf(href))
  const change = (href: string) => keyOf(href).endsWith("/change")
  const thatCard = (href: string) => keyOf(href) === "/library/mara"
  /** A kept workshop on the left and `beside` kept in a frame of its own; focus on the workshop. */
  const workshopAndCard = (beside: string) => {
    let layout = initialLayout("/chats/w")
    layout = pinTab(layout, focusedTab(layout)!.id)
    const chatFrame = focusedFrame(layout).id
    layout = splitFrame(layout, chatFrame, "row", { empty: true })
    const cardFrame = focusedFrame(layout).id
    layout = openTab(layout, beside, keyOf, { frame: cardFrame, preview: false })
    return { layout: focusFrame(layout, chatFrame), chatFrame, cardFrame }
  }

  it("opens the card where a card editor is shown, the workshop keeping its frame", () => {
    const { layout: start, chatFrame, cardFrame } = workshopAndCard("/library/ove")
    const layout = openTab(start, "/library/mara", keyOf, { frame: chatFrame, near: [editor] })
    expect(titles(layout)).toEqual([["/chats/w"], ["/library/ove", "/library/mara"]])
    expect(focusedFrame(layout).id).toBe(cardFrame)
  })

  it("reveals the item where it's shown, before another frame of its kind", () => {
    const { layout: start, chatFrame } = workshopAndCard("/library/ove")
    let layout = splitFrame(start, chatFrame, "row", { empty: true })
    const third = focusedFrame(layout).id
    layout = focusFrame(openTab(layout, "/library/mara", keyOf, { frame: third, preview: false }), chatFrame)
    const next = openTab(layout, "/library/mara?tab=notes", keyOf, { frame: chatFrame, near: [editor] })
    expect(focusedFrame(next).id).toBe(third)
    expect(titles(next)).toEqual(titles(layout))
  })

  it("tries the tests in order: a change view first, then that card's editor", () => {
    const { layout: start, chatFrame, cardFrame } = workshopAndCard("/library/mara")
    const near = [change, thatCard]
    const layout = openTab(start, "/library/mara/change?from=1&to=2", keyOf, { frame: chatFrame, near })
    expect(titles(layout)).toEqual([["/chats/w"], ["/library/mara", "/library/mara/change"]])
    expect(focusedFrame(layout).id).toBe(cardFrame)
    // Another card's editor isn't that card's: the change view opens where it was clicked.
    const other = workshopAndCard("/library/ove")
    const elsewhere = openTab(other.layout, "/library/mara/change?from=1&to=2", keyOf, {
      frame: other.chatFrame,
      near
    })
    expect(titles(elsewhere)).toEqual([["/chats/w", "/library/mara/change"], ["/library/ove"]])
  })

  it("opens as before when no shown tab passes", () => {
    let layout = initialLayout("/chats/w")
    layout = pinTab(layout, focusedTab(layout)!.id)
    const plain = openTab(layout, "/library/mara", keyOf, { id: "t" })
    expect(openTab(layout, "/library/mara", keyOf, { id: "t", near: [editor] })).toEqual(plain)
  })
})

// A frame keeps the room its strip needs (minframe1): repeated splits used to halve the
// rightmost frame to a sliver.
describe("workbench room", () => {
  const rightmost = (layout: Layout) => frames(layout.root).at(-1)!.id

  it("allows rightward splits only while both halves keep their least width", () => {
    let layout = initialLayout("/chats/a")
    let splits = 0
    for (let i = 0; i < 6; i++) {
      const next = splitFrame(layout, rightmost(layout), "row")
      if (!hasRoom(layout, next, 1340, 900)) break
      layout = next
      splits++
    }
    // 1340 → 670 → 335: a third halving would leave 167 px.
    expect(splits).toBe(2)
    for (const box of frameBoxes(layout.root, 1340, 900).values())
      expect(box.width).toBeGreaterThanOrEqual(MIN_FRAME_WIDTH - 1.5)
    // Down still fits: 900 → 450.
    expect(hasRoom(layout, splitFrame(layout, rightmost(layout), "column"), 1340, 900)).toBe(true)
  })

  it("counts only the frames a change adds or shrinks", () => {
    let layout = initialLayout("/chats/a")
    layout = splitFrame(layout, rightmost(layout), "row")
    // A saved layout with a sliver on the right (134 px of 1340): the wide frame still splits.
    const root = layout.root.type === "split" ? { ...layout.root, sizes: [0.9, 0.1] } : layout.root
    const stale = { ...layout, root }
    const [wide, sliver] = frames(stale.root)
    expect(hasRoom(stale, splitFrame(stale, wide!.id, "row"), 1340, 900)).toBe(true)
    expect(hasRoom(stale, splitFrame(stale, sliver!.id, "column"), 1340, 900)).toBe(false)
  })

  it("adds up a split's least size along its direction and takes the largest across", () => {
    let layout = initialLayout("/chats/a")
    layout = splitFrame(layout, rightmost(layout), "row")
    layout = splitFrame(layout, rightmost(layout), "column")
    expect(minSize(layout.root, "x")).toBe(2 * MIN_FRAME_WIDTH + 1)
    expect(minSize(layout.root, "y")).toBe(2 * MIN_FRAME_HEIGHT + 1)
  })
})
