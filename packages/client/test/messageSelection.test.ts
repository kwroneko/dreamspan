// Selecting messages to delete together (job msgactions1): ticks, Shift and Select range, the
// still-generating message, the limit, and that a range of 500 is quick. Synthetic entries only.
import { MULTI_DELETE_LIMIT } from "@dreamspan/shared/bin.ts"
import type { ForkId, PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import { expect, it } from "vitest"
import type { ChatSession } from "../src/features/chat/session.ts"
import { MessageSelection } from "../src/features/chat/selection/store.ts"

const entry = (i: number, patch: Partial<PathEntry> = {}) =>
  ({
    slotId: `slot-${i}` as SlotId,
    depth: i,
    position: i,
    versionCount: 2,
    version: { status: "complete" },
    ...patch
  }) as unknown as PathEntry

const fork = "fork-1" as ForkId

const sessionOf = (entries: ReadonlyArray<PathEntry>) =>
  ({ snapshot: () => ({ forkId: fork, entries }) }) as unknown as ChatSession

it("starts with the message chosen, ticks and unticks, and keeps the path's order", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i))
  const store = new MessageSelection(sessionOf(entries))
  store.start(entries[5]!)
  expect(store.snapshot()).toMatchObject({ active: true, forkId: fork })
  store.toggle(entries[2]!, true, false)
  store.toggle(entries[8]!, true, false)
  expect(store.ordered().map((t) => t.slotId)).toEqual(["slot-2", "slot-5", "slot-8"])
  store.toggle(entries[5]!, false, false)
  expect(store.ordered().map((t) => t.slotId)).toEqual(["slot-2", "slot-8"])
  expect(store.ordered()[0]!.versions).toBe(2)
  store.stop()
  expect(store.snapshot().active).toBe(false)
  expect(store.snapshot().ticked.size).toBe(0)
})

it("Shift or Select range ticks every message between, and skips one still being written", () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    entry(i, i === 4 ? ({ version: { status: "generating" } } as Partial<PathEntry>) : {})
  )
  const store = new MessageSelection(sessionOf(entries))
  store.start(entries[1]!)
  store.toggle(entries[6]!, true, true)
  expect(store.ordered().map((t) => t.slotId)).toEqual(["slot-1", "slot-2", "slot-3", "slot-5", "slot-6"])
  // Unticking a range, upwards, from the last tick.
  store.setRange(true)
  store.toggle(entries[5]!, false, false)
  expect(store.ordered().map((t) => t.slotId)).toEqual(["slot-1", "slot-2", "slot-3"])
  // The range mode ends after one use.
  expect(store.snapshot().range).toBe(false)
  store.toggle(entries[9]!, true, false)
  expect(store.ordered().map((t) => t.slotId)).toEqual(["slot-1", "slot-2", "slot-3", "slot-9"])
})

it("a message still being written isn't ticked when picking starts from it", () => {
  const generating = entry(0, { version: { status: "generating" } } as Partial<PathEntry>)
  const store = new MessageSelection(sessionOf([generating]))
  store.start(generating)
  expect(store.snapshot().active).toBe(true)
  expect(store.snapshot().ticked.size).toBe(0)
})

it("refuses a range past the limit and says so", () => {
  const entries = Array.from({ length: MULTI_DELETE_LIMIT + 5 }, (_, i) => entry(i))
  const store = new MessageSelection(sessionOf(entries))
  store.start(entries[0]!)
  store.toggle(entries.at(-1)!, true, true)
  expect(store.snapshot().ticked.size).toBe(1)
  expect(store.snapshot().notice).toContain("At most")
})

it("a range of 500 among 3,000 tells listeners once", () => {
  const entries = Array.from({ length: 3000 }, (_, i) => entry(i))
  const store = new MessageSelection(sessionOf(entries))
  store.start(entries[1000]!)
  let heard = 0
  store.subscribe(() => heard++)
  store.toggle(entries[1499]!, true, true)
  expect(store.snapshot().ticked.size).toBe(500)
  expect(heard).toBe(1)
})

// Live state can change while a selection is open, including from another browser tab.
it("reconciles a selected message that starts regenerating or disappears", () => {
  let entries = [entry(0), entry(1), entry(2)]
  let revision = 0
  const session = { snapshot: () => ({ forkId: fork, entries, pathRevision: revision }) } as unknown as ChatSession
  const store = new MessageSelection(session)
  store.start(entries[1]!)
  entries = [entries[0]!, entry(1, { version: { status: "generating" } } as Partial<PathEntry>), entries[2]!]
  store.reconcile()
  expect(store.snapshot().ticked.size).toBe(0)
  store.start(entries[2]!)
  revision++
  entries = entries.slice(0, 2)
  store.reconcile()
  expect(store.snapshot().active).toBe(false)
})

it("clears immediately on branch switch", () => {
  let shown = fork
  const entries = [entry(0)]
  const session = { snapshot: () => ({ forkId: shown, entries }) } as unknown as ChatSession
  const store = new MessageSelection(session)
  store.start(entries[0]!)
  shown = "fork-2" as ForkId
  store.reconcile()
  expect(store.snapshot().active).toBe(false)
})

it("measures selection with 5,000 loaded entries", { tags: ["slow"] }, () => {
  const entries = Array.from({ length: 5000 }, (_, i) => entry(i))
  const store = new MessageSelection(sessionOf(entries))
  const measure = (name: string, action: () => void) => {
    const start = performance.now()
    action()
    console.log("SELECTION_5000", name, (performance.now() - start).toFixed(3))
  }
  measure("enter", () => store.start(entries[2000]!))
  measure("range1000", () => store.toggle(entries[2999]!, true, true))
  expect(store.snapshot().ticked.size).toBe(1000)
  measure("cancel", () => store.stop())
  expect(store.snapshot().active).toBe(false)
})
