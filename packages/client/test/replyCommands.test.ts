import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PathEntry } from "@rp/shared/chat.ts"
import { chatCommands, runCommandShortcut, type ChatCommandContext } from "../src/features/chat/commands.tsx"
import { invokeMessageAction, messageActions } from "../src/features/chat/messageActions.tsx"
import { registerReplyCommands } from "../src/features/chat/replyCommands.ts"
import { registerMessageActions } from "../src/features/chat/registerMessageActions.tsx"
import type { ChatSession } from "../src/features/chat/session.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
let disposers: Array<() => void>
beforeEach(() => {
  disposers = [...registerMessageActions(), ...registerReplyCommands()]
})
afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
})
const entry = {
  slotId: "synthetic",
  version: { writer: "model", status: "complete", content: "reply" }
} as unknown as PathEntry
const setup = (model: object | null = { prefill: "assistant" }) => {
  const view = { entries: [entry], newer: null, forkId: "synthetic", history: { model } }
  const session = { snapshot: () => view, continueVersion: vi.fn(async () => ({ ok: true })) } as unknown as ChatSession
  const context = { session, view } as unknown as ChatCommandContext
  return { context, session, view }
}
const key = { key: "Enter", altKey: true, ctrlKey: false, metaKey: false }

it("continues through the registered action without composer guidance, and honors replacement and disablement", async () => {
  const { context, session } = setup()
  expect(runCommandShortcut(key, context)).toBe(true)
  expect(session.continueVersion).toHaveBeenCalledWith(entry, false)
  const run = vi.fn()
  disposers.push(messageActions.register({ ...messageActions.get("message.continue")!, run }))
  runCommandShortcut(key, context)
  expect(run).toHaveBeenCalledOnce()
  disposers.push(messageActions.disable("message.continue"))
  expect(runCommandShortcut(key, context)).toBe(false)
  disposers.push(chatCommands.disable("reply.continue"))
  expect(runCommandShortcut(key, context)).toBe(false)
})

it("shares latest-reply availability and reports unavailable capability without continuing", async () => {
  const { context, session, view } = setup({ prefill: "none" })
  const report = vi.fn()
  const target = { entry, session, report } as unknown as Parameters<typeof invokeMessageAction>[1]
  await invokeMessageAction("message.continue", target, "keyboard")
  expect(session.continueVersion).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  view.entries = []
  expect(runCommandShortcut(key, context)).toBe(false)
})

it("ignores composition, repeated keys and extra modifiers", () => {
  const { context } = setup()
  for (const extra of [{ isComposing: true }, { shiftKey: true }, { ctrlKey: true }, { repeat: true }])
    expect(runCommandShortcut({ ...key, ...extra }, context)).toBe(false)
})

it("editing and saving resolve registered handlers, including disablement", () => {
  const { context, view, session } = setup()
  const own = { ...entry, side: "user", slotId: "human", version: { ...entry.version, writer: "human" } } as PathEntry
  view.entries = [own, entry]
  const edit = vi.fn()
  disposers.push(messageActions.register({ ...messageActions.get("message.edit")!, run: edit }))
  expect(runCommandShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false }, context)).toBe(true)
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({ entry: own, session }), "keyboard")
  disposers.push(messageActions.disable("message.edit"))
  expect(runCommandShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false }, context)).toBe(false)
  const saveMessageEdit = vi.fn()
  const saving = { ...context, saveMessageEdit }
  expect(runCommandShortcut({ key: "Enter", ctrlKey: true, metaKey: false }, saving)).toBe(true)
  expect(saveMessageEdit).toHaveBeenCalledOnce()
  disposers.push(chatCommands.disable("message.save"))
  expect(runCommandShortcut({ key: "Enter", ctrlKey: true, metaKey: false }, saving)).toBe(false)
})
