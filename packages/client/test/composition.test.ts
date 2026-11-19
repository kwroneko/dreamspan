// The composition scratchpad (DESIGN §3.1): text added to the end of your own version of a
// message, from the bar over the version shown or from a snippet's editor, as registered,
// replaceable text actions; the draft of two views of one chat kept the same.
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
import { Effect } from "effect"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { registerCompositionActions } from "../src/features/chat/compositionActions.tsx"
import { appended, compositionTarget, registerComposition } from "../src/features/chat/composition.ts"
import { MessageDraft } from "../src/features/chat/messageDraft.ts"
import type { ChatSession } from "../src/features/chat/session.ts"
import { editorTextActions, textActions } from "../src/textActions.tsx"

vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" }))
vi.mock("../src/ui/Toast.tsx", () => ({ showToast: vi.fn() }))

let dispose: Array<() => void>
beforeEach(() => {
  dispose = registerCompositionActions()
})
afterEach(() => {
  for (const close of dispose.reverse()) close()
})

const offered = (selection: string, scope: Parameters<typeof editorTextActions>[5], source?: "snippet") =>
  editorTextActions(textActions.snapshot().entries, "Whole version", selection, source, true, scope).map(
    ({ action, context }) => [action.id, context.text, action.available(context)]
  )

it("adds after a blank line, the end's own blank lines folded", () => {
  expect(appended("", "First")).toEqual({ next: "First", at: 0, length: 5 })
  expect(appended("First\n\n\n", "Second")).toEqual({ next: "First\n\nSecond", at: 7, length: 6 })
})

it("offers the selection and the whole version over a version being composed from, never elsewhere", () => {
  const add = vi.fn()
  const ownVersion = { name: "message #3", add }
  expect(offered("", {})).toEqual([])
  expect(offered("", { ownVersion })).toEqual([["version.add-text", "Whole version", true]])
  // The selection's first: the bar is end-aligned, so it comes and goes without moving the other.
  expect(offered("a passage", { ownVersion })).toEqual([
    ["version.add-selection", "a passage", true],
    ["version.add-text", "Whole version", true]
  ])
  textActions.get("version.add-selection")!.run({ text: "a passage", ownVersion })
  expect(add).toHaveBeenCalledWith("a passage")
  // A plugin can replace it.
  const replacement = vi.fn()
  const undo = textActions.register({ ...textActions.get("version.add-text")!, run: replacement })
  textActions.get("version.add-text")!.run({ text: "x", ownVersion })
  expect(replacement).toHaveBeenCalled()
  undo()
})

it("a snippet's editor adds to the composition used last that still shows", () => {
  // No composition shown: the button keeps its place, unavailable, saying why.
  expect(offered("", {}, "snippet")).toEqual([["version.add-text", "Whole version", false]])
  expect(textActions.get("version.add-text")!.unavailable!({ text: "Some text", source: "snippet" })).toBe(
    "Open “Write your own version” on a message to add text to it."
  )
  const element = (connected: boolean) => ({ isConnected: connected }) as HTMLElement
  const first = { name: "message #2", add: vi.fn() }
  const second = { name: "message #5", add: vi.fn() }
  const a = registerComposition(element(true), first)
  const b = registerComposition(element(true), second)
  expect(compositionTarget()).toBe(second)
  a.use()
  expect(compositionTarget()).toBe(first)
  textActions.get("version.add-text")!.run({ text: "Snippet text", source: "snippet" })
  expect(first.add).toHaveBeenCalledWith("Snippet text")
  const description = textActions.get("version.add-text")!.description as (c: { text: string }) => string
  expect(description({ text: "x" })).toBe("Adds this snippet's text to the end of your version of message #2.")
  a.forget()
  expect(compositionTarget()).toBe(second)
  b.forget()
  expect(compositionTarget()).toBe(null)
})

const draft = (content: string, rowVersion: number, status: "active" | "committed" = "active") =>
  new Draft({
    id: "draft",
    key: new DraftKey({ targetKind: "scratchpad", targetId: "slot", field: "" }),
    content,
    rowVersion,
    session: 1,
    baseRevision: null,
    status,
    createdAt: 1,
    updatedAt: 1,
    recovered: 0,
    displaced: null,
    historyLength: 1
  })

it("appends once the saved text is read, marks what it added, and shares the server's answer", async () => {
  const shared: Array<string> = []
  const session = {
    id: "chat",
    shareDraft: (_target: unknown, answer: Draft) => shared.push(answer.content),
    call: async (run: (client: unknown) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(
        run((tag: string, payload: { content: string }) =>
          Effect.succeed(tag === "GetMessageDraft" ? draft("Kept from before", 1) : draft(payload.content, 2))
        )
      )
    })
  } as unknown as ChatSession
  const editor = new MessageDraft(session, "owner", { _tag: "Write", slotId: "slot" as SlotId }, "", null)
  await editor.append("A passage")
  expect(editor.snapshot()).toMatchObject({
    text: "Kept from before\n\nA passage",
    added: { at: 18, length: 9 }
  })
  await editor.save()
  expect(shared).toEqual(["Kept from before\n\nA passage"])
})

it("another view's answer shows unless text typed here waits for the server", () => {
  const session = { id: "chat", call: async () => ({ ok: false }) } as unknown as ChatSession
  const editor = new MessageDraft(session, "owner", { _tag: "Write", slotId: "slot" as SlotId }, "", draft("One", 1))
  editor.adopt(draft("One and two", 2))
  expect(editor.snapshot().text).toBe("One and two")
  // An older answer arriving late changes nothing.
  editor.adopt(draft("One", 1))
  expect(editor.snapshot().text).toBe("One and two")
  editor.setText("Typed here")
  editor.adopt(draft("Elsewhere", 3))
  expect(editor.snapshot().text).toBe("Typed here")
  expect(editor.settled).toBe(false)
})
