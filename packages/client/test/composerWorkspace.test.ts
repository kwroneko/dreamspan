import { expect, it, vi } from "vitest"
import type { ChatSession } from "../src/features/chat/session.ts"
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
