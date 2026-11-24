import { createMemoryHistory } from "@tanstack/react-router"
import { describe, expect, it, vi } from "vitest"
import { portraitSources } from "../src/features/chat/portraitSources.ts"
import { WorkbenchStore } from "../src/features/workbench/store.ts"
import type { Portrait, PortraitViewer } from "../src/ui/Portrait.tsx"

const original: Portrait = { id: "card", name: "Keeper", mediaId: "original" }
const revised: Portrait = { ...original, mediaId: "revised" }
const cropped: Portrait = { ...original, picture: { x: 0, y: 0, width: 0.5, height: 0.5 } }
const supplied: Portrait = { ...original, src: "/local-preview.png" }

const source = (portrait: Portrait): { viewer: PortraitViewer; asTab: null } => ({
  asTab: null,
  viewer: {
    shown: [{ portrait, weight: 1 }],
    single: false,
    open: vi.fn(),
    show: vi.fn(),
    replace: vi.fn(),
    close: vi.fn(),
    split: vi.fn(),
    even: vi.fn(),
    move: vi.fn(),
    setSingle: vi.fn(),
    set: vi.fn()
  }
})

const setup = () => {
  const store = new WorkbenchStore("user", createMemoryHistory({ initialEntries: ["/chats/a"] }), null, () => {})
  const sources = portraitSources(store)
  const left = source(original)
  const right = source(revised)
  const copy = source(original)
  sources.publish("left", left)
  sources.publish("right", right)
  sources.publish("copy", copy)
  return { sources, left, right, copy }
}

describe("the workbench portrait column", () => {
  it("groups matching pictures of a card and distinguishes revisions, crops and explicit sources", () => {
    const { sources } = setup()
    sources.publish("crop", source(cropped))
    sources.publish("preview", source(supplied))
    const shown = () => sources.snapshot().entries.map((entry) => entry.owned.portrait)
    expect(shown()).toEqual([supplied, cropped, revised, original])

    // A new source URL under the same holder must be published too.
    const changed = { ...supplied, src: "/changed-preview.png" }
    sources.publish("preview", source(changed))
    expect(shown()).toEqual([changed, cropped, revised, original])
  })

  it("closes only the selected picture when another revision of the same card is open", () => {
    const { sources, left, right, copy } = setup()
    const shared = sources.viewer(sources.snapshot(), "left", left.viewer)
    shared.close(shared.shown.find((entry) => entry.portrait.mediaId === original.mediaId)!.portrait.id)
    expect(left.viewer.set).toHaveBeenCalledWith([])
    expect(copy.viewer.set).toHaveBeenCalledWith([])
    expect(right.viewer.set).not.toHaveBeenCalled()
  })

  it("uses the shown picture for portrait toggles and single-image actions in other views", () => {
    const { sources, left, right, copy } = setup()
    sources.changeOtherViews("left", original, "close")
    expect(copy.viewer.set).toHaveBeenCalledWith([])
    expect(right.viewer.set).not.toHaveBeenCalled()

    sources.changeOtherViews("left", original, "keep")
    expect(right.viewer.set).toHaveBeenCalledWith([])
    expect(copy.viewer.set).toHaveBeenCalledTimes(1)
    expect(left.viewer.set).not.toHaveBeenCalled()
  })
})
