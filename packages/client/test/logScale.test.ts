// The log slider's scale (logslider1, owner 2026-11-24): a thumb's place is log(value) between
// the ends, a drag gives readable values, and keys always move.
import { describe, expect, it } from "vitest"
import { LOG_POSITIONS, logScale, readable } from "../src/ui/logScale.ts"

describe("readable", () => {
  it("prefers powers of two at the low end and round figures above", () => {
    expect([127, 260, 1000, 1030, 2010, 4100].map(readable)).toEqual([128, 256, 1024, 1024, 2048, 4096])
    expect([63.4, 300.4, 8100, 15_600, 32_400, 127_600, 201_000, 999_000].map(readable)).toEqual([
      63, 300, 8100, 16_000, 32_000, 128_000, 201_000, 999_000
    ])
    for (const n of [64, 128, 256, 512, 1024, 2048, 4096, 8000, 16_000, 128_000]) expect(readable(n)).toBe(n)
  })
})

describe("logScale", () => {
  const context = logScale(1024, 1_000_000)

  it("puts a value at its log place and the ends at the ends", () => {
    expect(context.positionOf(1024)).toBe(0)
    expect(context.positionOf(1_000_000)).toBe(LOG_POSITIONS)
    // The geometric mean of the ends sits halfway.
    expect(context.positionOf(Math.sqrt(1024 * 1_000_000))).toBeCloseTo(LOG_POSITIONS / 2, 6)
    expect(context.valueAt(0)).toBe(1024)
    expect(context.valueAt(LOG_POSITIONS)).toBe(1_000_000)
    // A quarter of the way is far below a tenth of the maximum.
    expect(context.valueAt(LOG_POSITIONS / 4)).toBeLessThan(10_000)
  })

  it("places a typed value exactly, between its neighbours", () => {
    expect(context.positionOf(50_000)).toBeGreaterThan(context.positionOf(49_999))
    expect(context.positionOf(50_001)).toBeGreaterThan(context.positionOf(50_000))
    expect(context.positionOf(5)).toBe(0)
    expect(context.positionOf(5_000_000)).toBe(LOG_POSITIONS)
  })

  it("round-trips every snapped value to the same value", () => {
    for (let position = 0; position <= LOG_POSITIONS; position += 1) {
      const value = context.valueAt(position)
      expect(readable(value) === value || value === 1024 || value === 1_000_000).toBe(true)
      expect(context.valueAt(context.positionOf(value))).toBe(value)
    }
  })

  it("gives values that only grow along the track", () => {
    let last = 0
    for (let position = 0; position <= LOG_POSITIONS; position += 1) {
      const value = context.valueAt(position)
      expect(value).toBeGreaterThanOrEqual(last)
      last = value
    }
  })

  it("steps by keys always move, by a hundredth or a tenth of the track", () => {
    const reply = logScale(64, 943_718)
    let value = 64
    const seen = [value]
    while (value < 943_718) {
      const next = reply.stepFrom(value, 1, false)
      expect(next).toBeGreaterThan(value)
      seen.push((value = next))
    }
    expect(seen.length).toBeGreaterThan(60)
    expect(seen.length).toBeLessThan(110)
    expect(seen).toContain(4096)
    expect(reply.stepFrom(943_718, 1, false)).toBe(943_718)
    expect(reply.stepFrom(64, -1, false)).toBe(64)
    expect(reply.stepFrom(4096, -1, false)).toBeLessThan(4096)
    // A tenth of the track is about ×2.6 here.
    const big = reply.stepFrom(4096, 1, true)
    expect(big / 4096).toBeGreaterThan(2)
    expect(big / 4096).toBeLessThan(3.5)
  })

  it("starts a range at 0 shifted by one, as the card filters use it", () => {
    const tokens = logScale(0, 100_000)
    expect(tokens.valueAt(0)).toBe(0)
    expect(tokens.positionOf(0)).toBe(0)
    expect(tokens.valueAt(LOG_POSITIONS)).toBe(100_000)
  })
})
