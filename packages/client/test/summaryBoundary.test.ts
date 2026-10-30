import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmState } from "@rp/shared/lcm.ts"
import { describe, expect, it } from "vitest"
import { boundaryIndex } from "../src/features/chat/summaryBoundary.ts"
import type { ChatView } from "../src/features/chat/session.ts"

const entry = (id: string, depth: number, position?: number) =>
  ({ slotId: id as SlotId, depth, ...(position === undefined ? {} : { position }) }) as PathEntry
const view = (entries: ReadonlyArray<PathEntry>, lcm: Partial<LcmState>) =>
  ({
    leafSlotId: "leaf" as SlotId,
    entries,
    older: null,
    newer: null,
    lcm: { enabled: true, leafSlotId: "leaf", ...lcm }
  }) as unknown as ChatView

describe("the summary boundary in the message list", () => {
  it("goes after the cursor by display position (spec/MESSAGE-INSERT.md §3.4)", () => {
    // m0, m1, X inserted below m1 (structural depth 2, position 2), m2 (depth 2, position 3).
    const entries = [entry("m0", 0, 0), entry("m1", 1, 1), entry("x", 2, 2), entry("m2", 2, 3)]
    // The cursor on X: by depth it would swallow m2 too.
    expect(boundaryIndex(view(entries, { cursorDepth: 2, cursorPosition: 2 }))).toBe(3)
    // The cursor on m1, X raw after it.
    expect(boundaryIndex(view(entries, { cursorDepth: 1, cursorPosition: 1 }))).toBe(2)
  })

  it("compares depths without positions, as before insertions", () => {
    const entries = [entry("m0", 0), entry("m1", 1), entry("m2", 2)]
    expect(boundaryIndex(view(entries, { cursorDepth: 1 }))).toBe(2)
    expect(boundaryIndex(view(entries, { cursorDepth: -1 }))).toBe(0)
  })
})
