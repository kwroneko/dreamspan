import { afterEach, expect, it, vi } from "vitest"
import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import { messageVersions } from "../src/features/chat/presentation.tsx"
import { invokeVersionStep, stepVersion } from "../src/features/chat/versionNavigation.ts"
import type { MessageActionContext } from "../src/features/chat/messageActions.tsx"
import type { ChatSession } from "../src/features/chat/session.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})
const versions = ["a", "hidden", "b"].map((id) => ({ id, hidden: id === "hidden" })) as unknown as Version[]
const entry = { slotId: "slot", version: versions[0], versionCount: 3 } as unknown as PathEntry
const setup = () => {
  const view = { forkId: "fork", entries: [entry], loading: false }
  const session = {
    snapshot: () => view,
    listVersions: vi.fn(async () => ({ ok: true, value: versions })),
    select: vi.fn(async () => ({ ok: true })),
    regenerate: vi.fn(async () => ({ ok: true }))
  } as unknown as ChatSession
  const report = vi.fn()
  return {
    view,
    session,
    report,
    context: { entry, session, report, generated: true } as unknown as MessageActionContext
  }
}
it("skips hidden versions and generates when Right goes past the last", async () => {
  const { session, report, view } = setup()
  await stepVersion(entry, session, true, report, 1)
  expect(session.select).toHaveBeenCalledWith(entry, versions[2])
  const last = { ...entry, version: versions[2]! }
  view.entries = [last]
  await stepVersion(last, session, true, report, 1)
  expect(session.regenerate).toHaveBeenCalledWith(last)
})
it("dispatches replacements and disabling through the same navigation as gestures", async () => {
  const { context } = setup()
  const step = vi.fn()
  disposers.push(messageVersions.register({ id: "message.versions", order: 10, component: () => null, step }))
  await invokeVersionStep(context, -1)
  expect(step).toHaveBeenCalledWith(expect.objectContaining({ entry }), -1)
  disposers.push(messageVersions.disable("message.versions"))
  await invokeVersionStep(context, 1)
  expect(step).toHaveBeenCalledOnce()
})
it("drops an awaited version read after a fork changes", async () => {
  const { view, session, report } = setup()
  await stepVersion(entry, session, true, report, 1, async () => {
    view.forkId = "other"
    return versions
  })
  expect(session.select).not.toHaveBeenCalled()
  expect(session.regenerate).not.toHaveBeenCalled()
})
