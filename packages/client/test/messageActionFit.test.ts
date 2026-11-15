import { describe, expect, it } from "vitest"
import { MessageActionFit } from "../src/features/chat/messageActionFit.ts"

describe("message toolbar measurements", () => {
  it("retains the latest capacity while the current pins all fit", () => {
    const fit = new MessageActionFit()
    expect(fit.visible(4)).toBe(4)
    fit.setCapacity(9)
    fit.setCapacity(6)
    expect(fit.visible(4)).toBe(4)
    // Adding pins uses the actual latest measurement, not the old all-fit result.
    expect(fit.visible(8)).toBe(6)
    fit.setCapacity(2)
    expect(fit.visible(4)).toBe(2)
    fit.setCapacity(7)
    expect(fit.visible(4)).toBe(4)
    expect(fit.visible(0)).toBe(0)
  })

  it("publishes stable visible snapshots and releases an unmounted toolbar", () => {
    const fit = new MessageActionFit()
    let current = fit.visible(4)
    const changes: number[] = []
    const stop = fit.subscribe(() => {
      const next = fit.visible(4)
      if (next !== current) changes.push(next)
      current = next
    })
    fit.setCapacity(8)
    fit.setCapacity(6)
    expect(changes).toEqual([])
    fit.setCapacity(3)
    fit.setCapacity(0)
    fit.setCapacity(9)
    expect(changes).toEqual([3, 0, 4])
    stop()
    fit.setCapacity(1)
    expect(changes).toEqual([3, 0, 4])
  })
})
