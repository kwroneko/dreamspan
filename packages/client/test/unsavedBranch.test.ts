// A branch's own changes count only while their scope shows that branch (owner, 2026-11-24).
import { expect, it } from "vitest"
import { UnsavedTracker } from "../src/ui/UnsavedChanges.tsx"

const source = (branch: { chatId: string; forkId: string | null } | null) => ({
  subscribe: () => () => {},
  changed: () => true,
  branch: () => branch
})

it("a chat note's changes count on their branch only, and again when it's shown", () => {
  const tracker = new UnsavedTracker()
  tracker.showBranch({ chatId: "chat", forkId: "a" })
  tracker.add("notes", source({ chatId: "chat", forkId: "a" }))
  tracker.add("card", source(null))
  tracker.add("other", source({ chatId: "another chat", forkId: "x" }))
  expect([...tracker.snapshot()].sort()).toEqual(["card", "notes", "other"])
  tracker.showBranch({ chatId: "chat", forkId: "b" })
  expect([...tracker.snapshot()].sort()).toEqual(["card", "other"])
  tracker.showBranch({ chatId: "chat", forkId: "a" })
  expect(tracker.snapshot().has("notes")).toBe(true)
  tracker.dispose()
})
