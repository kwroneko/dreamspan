// The fork badges' family index is read once per real change: badges mount and unmount as grids
// filter, and a query dropped with its last badge was cancelled and sent again (e2efix1: 9 times).
import { describe, expect, it } from "vitest"
import { familyIndexAtom } from "../src/features/cardForks/surfacesImpl.tsx"

describe("fork badge family index", () => {
  it("outlives its last badge", () => {
    expect(familyIndexAtom.keepAlive).toBe(true)
  })
})
