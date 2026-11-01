// The desktop's columns share the window less the middle's minimum: as chosen when they fit,
// giving way toward their minimums when they don't, the portrait first; dragging one goes as
// far as the room the others leave.
import { describe, expect, it } from "vitest"
import { allocate, type ColumnEntry, maxWidth } from "../src/ui/columnLayout.ts"

const columns = (entries: Record<string, ColumnEntry>) => new Map(Object.entries(entries))
const round = (widths: Map<string, number>) => Object.fromEntries([...widths].map(([k, v]) => [k, Math.round(v)]))

describe("allocate", () => {
  const sides = columns({ sidebar: { preferred: 600, min: 220 }, chat: { preferred: 800, min: 260 } })

  it("shows each column as chosen when they fit", () => {
    expect(round(allocate(sides, 1920 - 440))).toEqual({ sidebar: 600, chat: 800 })
  })

  it("narrows each in proportion to how far it is above its minimum", () => {
    // 1440: 1000 px for both, 400 short; 380 and 540 above their minimums.
    const widths = allocate(sides, 1000)
    expect(round(widths)).toEqual({ sidebar: 435, chat: 565 })
    expect([...widths.values()].reduce((a, b) => a + b)).toBeCloseTo(1000)
  })

  it("stops at the minimums", () => {
    expect(round(allocate(sides, 300))).toEqual({ sidebar: 220, chat: 260 })
  })

  it("narrows the portrait first, then the others", () => {
    const three = columns({
      sidebar: { preferred: 320, min: 220 },
      chat: { preferred: 416, min: 260 },
      portrait: { preferred: 560, min: 200, yields: 1 }
    })
    // 1440: 1000 px, 296 short; the portrait has 360 to give.
    expect(round(allocate(three, 1000))).toEqual({ sidebar: 320, chat: 416, portrait: 264 })
    // 1200: 760 px, 536 short; the portrait gives 360, the others the rest.
    const narrow = round(allocate(three, 760))
    expect(narrow.portrait).toBe(200)
    expect(narrow.sidebar! + narrow.chat!).toBe(560)
    expect(narrow.sidebar).toBeLessThan(320)
    expect(narrow.chat).toBeLessThan(416)
  })

  it("never shows less than a column's minimum, whatever was stored", () => {
    expect(round(allocate(columns({ sidebar: { preferred: 10, min: 220 } }), 2000))).toEqual({ sidebar: 220 })
  })
})

describe("maxWidth", () => {
  it("is the room less what the others show", () => {
    const entries = columns({ sidebar: { preferred: 320, min: 220 }, chat: { preferred: 416, min: 260 } })
    const widths = allocate(entries, 3840 - 440)
    expect(maxWidth("sidebar", entries, widths, 3400)).toBe(3400 - 416)
    expect(maxWidth("chat", entries, widths, 3400)).toBe(3400 - 320)
  })

  it("counts only the minimum of a column that gives way first", () => {
    const entries = columns({
      sidebar: { preferred: 320, min: 220 },
      portrait: { preferred: 560, min: 200, yields: 1 }
    })
    const widths = allocate(entries, 1480)
    expect(maxWidth("sidebar", entries, widths, 1480)).toBe(1480 - 200)
    expect(maxWidth("portrait", entries, widths, 1480)).toBe(1480 - 320)
  })

  it("is at least the column's minimum", () => {
    const entries = columns({ sidebar: { preferred: 900, min: 220 }, chat: { preferred: 900, min: 260 } })
    expect(maxWidth("sidebar", entries, allocate(entries, 400), 400)).toBe(220)
  })
})
