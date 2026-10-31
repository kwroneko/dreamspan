import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PathEntry } from "@rp/shared/chat.ts"
import { chatCommands, runCommandShortcut, type ChatCommandContext } from "../src/features/chat/commands.tsx"
import { invokeMessageAction, messageActions } from "../src/features/chat/messageActions.tsx"
import { registerReplyCommands } from "../src/features/chat/replyCommands.ts"
import { registerMessageActions } from "../src/features/chat/registerMessageActions.tsx"
import { messageVersions } from "../src/features/chat/presentation.tsx"
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

it("continues a model without prefill (owner, 2026-10-31), and reports an unresolved capability without continuing", async () => {
  const none = setup({ prefill: "none" })
  expect(runCommandShortcut(key, none.context)).toBe(true)
  expect(none.session.continueVersion).toHaveBeenCalledWith(entry, false)
  const { context, session, view } = setup({})
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

it("targets the current played side, including model-written personas and human-written characters", () => {
  const { context, view } = setup()
  const persona = {
    ...entry,
    slotId: "persona-turn",
    side: "assistant",
    version: { ...entry.version, speakerEntityId: "persona" }
  } as unknown as PathEntry
  const character = {
    ...entry,
    slotId: "character-turn",
    side: "user",
    version: { ...entry.version, writer: "human", speakerEntityId: "character" }
  } as unknown as PathEntry
  view.entries = [persona, character]
  Object.assign(view, { cast: { participants: ["persona", "character"], playedByMe: ["persona"] } })
  const edit = vi.fn()
  const step = vi.fn()
  disposers.push(messageActions.register({ ...messageActions.get("message.edit")!, run: edit }))
  disposers.push(messageVersions.register({ id: "message.versions", order: 10, component: () => null, step }))
  expect(runCommandShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false }, context)).toBe(true)
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({ entry: persona }), "keyboard")
  expect(runCommandShortcut({ key: "ArrowRight", ctrlKey: false, metaKey: false }, context)).toBe(true)
  expect(step).toHaveBeenCalledWith(expect.objectContaining({ entry: character }), 1)
})

it("finds your last message beyond the loaded window through the same registered edit action", async () => {
  const { context, view, session } = setup()
  const own = { ...entry, slotId: "older-own", side: "user", version: { ...entry.version, writer: "human" } }
  Object.assign(view, { older: "older-page", pathRevision: 1, leafSlotId: "synthetic" })
  const call = vi.fn(async () => ({ ok: true, value: { entries: [own], older: null } }))
  Object.assign(session, { call })
  const onJump = vi.fn()
  const edit = vi.fn()
  disposers.push(messageActions.register({ ...messageActions.get("message.edit")!, run: edit }))
  expect(runCommandShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false }, { ...context, onJump })).toBe(true)
  await vi.waitFor(() => expect(edit).toHaveBeenCalledWith(expect.objectContaining({ entry: own }), "keyboard"))
  expect(onJump).toHaveBeenCalledWith("older-own")
  expect(call).toHaveBeenCalledOnce()
})

it("cancels an older-message search when its fork, tip, path or cast changes or editing is disabled", async () => {
  for (const patch of [{ forkId: "other" }, { leafSlotId: "other" }, { pathRevision: 2 }, { cast: {} }, {}]) {
    const { context, view, session } = setup()
    const own = { ...entry, side: "user" } as PathEntry
    Object.assign(view, { older: "older-page", pathRevision: 1, leafSlotId: "synthetic" })
    const read = Promise.withResolvers<{ ok: true; value: { entries: PathEntry[]; older: null } }>()
    Object.assign(session, { call: () => read.promise })
    const edit = vi.fn()
    const onJump = vi.fn()
    disposers.push(messageActions.register({ ...messageActions.get("message.edit")!, run: edit }))
    expect(runCommandShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false }, { ...context, onJump })).toBe(true)
    Object.assign(session, { snapshot: () => ({ ...view, ...patch }) })
    const enable = Object.keys(patch).length === 0 ? messageActions.disable("message.edit") : () => {}
    read.resolve({ ok: true, value: { entries: [own], older: null } })
    await read.promise
    expect(edit).not.toHaveBeenCalled()
    expect(onJump).not.toHaveBeenCalled()
    enable()
  }
})

it("continues a completed human edit through both the visible action and its shortcut", async () => {
  const { context, session, view } = setup()
  const edited = { ...entry, version: { ...entry.version, writer: "human", origin: "edited" } } as PathEntry
  view.entries = [edited]
  await invokeMessageAction(
    "message.continue",
    { entry: edited, session, report: vi.fn() } as unknown as Parameters<typeof invokeMessageAction>[1],
    "button"
  )
  expect(session.continueVersion).toHaveBeenLastCalledWith(edited, true)
  expect(runCommandShortcut(key, context)).toBe(true)
  expect(session.continueVersion).toHaveBeenLastCalledWith(edited, false)
})
