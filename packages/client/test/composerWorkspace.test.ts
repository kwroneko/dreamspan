import { expect, it, vi } from "vitest"
import type { ChatSession } from "../src/features/chat/session.ts"
import type { ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { composerWorkspace } from "../src/features/chat/composerWorkspace.ts"

it("keeps a remounted composer's draft queue and in-flight feedback with its session", () => {
  const session = {} as ChatSession
  const before = composerWorkspace(session, "synthetic-user")
  const oldCallback = before.setError
  before.setBusy(true)
  const after = composerWorkspace(session, "synthetic-user")
  const listener = vi.fn()
  const close = after.subscribe(listener)
  const error = { tag: "BranchChanged", message: "branch changed", problems: [], reason: null }
  oldCallback(error)
  expect(after.draft).toBe(before.draft)
  expect(after.snapshot()).toEqual({ busy: true, error })
  expect(listener).toHaveBeenCalledOnce()
  before.setBusy(false)
  expect(after.snapshot().busy).toBe(false)
  expect(composerWorkspace({} as ChatSession, "synthetic-user").draft).not.toBe(before.draft)
  close()
})

it("reads once across remounts, and again for a moved tip, branch or new open generation", () => {
  let view = { loading: true, forkId: "fork-1" as ForkId, leafSlotId: "slot-1" as SlotId, opened: 0 }
  const takeBranchStart = vi.fn(() => false)
  const session = { snapshot: () => view, takeBranchStart } as unknown as ChatSession
  const workspace = composerWorkspace(session, "synthetic-user")
  const setFork = vi.spyOn(workspace.draft, "setFork").mockImplementation(() => {})
  workspace.syncFork()
  expect(setFork).not.toHaveBeenCalled()
  view = { ...view, loading: false, opened: 1 }
  workspace.syncFork()
  composerWorkspace(session, "synthetic-user").syncFork()
  expect(setFork).toHaveBeenCalledTimes(1)
  view = { ...view, leafSlotId: "slot-2" as SlotId }
  workspace.syncFork()
  view = { ...view, opened: 2 }
  workspace.syncFork()
  view = { ...view, forkId: "fork-2" as ForkId }
  takeBranchStart.mockReturnValueOnce(true)
  workspace.syncFork()
  expect(setFork).toHaveBeenCalledTimes(4)
  expect(setFork).toHaveBeenLastCalledWith("fork-2", true)
  expect(takeBranchStart).toHaveBeenCalledTimes(4)
})
