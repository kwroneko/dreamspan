// The chat view's live frames (ui/html/frames.ts): at most eight, the oldest offscreen unloads.
import { describe, expect, it } from "vitest"
import { FrameSlots, MAX_LIVE_FRAMES } from "../src/ui/html/frames.ts"

describe("FrameSlots", () => {
  it("loads at most eight frames, unloading the one offscreen longest", () => {
    const slots = new FrameSlots()
    const unloaded: string[] = []
    for (let i = 0; i < MAX_LIVE_FRAMES; i++) expect(slots.claim(`f${i}`, () => unloaded.push(`f${i}`))).toBe(true)
    slots.away("f3")
    slots.away("f1")
    expect(slots.claim("f8", () => unloaded.push("f8"))).toBe(true)
    expect(unloaded).toEqual(["f3"])
    expect(slots.claim("f9", () => unloaded.push("f9"))).toBe(true)
    expect(unloaded).toEqual(["f3", "f1"])
    expect(slots.size).toBe(MAX_LIVE_FRAMES)
  })

  it("makes a frame wait while every loaded frame is on screen", () => {
    const slots = new FrameSlots(2)
    slots.claim("a", () => {})
    slots.claim("b", () => {})
    let retried = 0
    expect(slots.claim("c", () => {})).toBe(false)
    slots.wait("c", () => retried++)
    slots.away("a")
    expect(retried).toBe(1)
    expect(slots.claim("c", () => {})).toBe(true)
    expect(slots.size).toBe(2)
  })

  it("keeps a frame that comes back on screen", () => {
    const slots = new FrameSlots(1)
    const unloaded: string[] = []
    slots.claim("a", () => unloaded.push("a"))
    slots.away("a")
    expect(slots.claim("a", () => unloaded.push("a"))).toBe(true)
    expect(unloaded).toEqual([])
    slots.release("a")
    expect(slots.size).toBe(0)
  })
})
