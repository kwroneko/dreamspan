// A chat session's window against events that arrive while a read is in flight: the
// server may answer the read from before them, and the reply mustn't undo them.
import type { Chat, ChatId, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent, PathWindow } from "@rp/shared/chatApi.ts"
import { AtomRegistry } from "effect/reactivity"
import { describe, expect, it, vi } from "vitest"

// rpc.ts reads the page's location when imported.
vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession } = await import("../src/features/chat/session.ts")

const chatId = "chat-1" as ChatId
const chat = {
  id: chatId,
  kind: "rp",
  status: "active",
  title: "Harbor",
  activeLeafSlotId: "s2",
  rowVersion: 3,
  createdAt: 0,
  lastMessageAt: 0
} as unknown as Chat

const version = (id: string, slotId: string, status: Version["status"], content: string) =>
  ({
    id: id as VersionId,
    slotId: slotId as SlotId,
    ordinal: 0,
    status,
    speakerEntityId: null,
    writer: "model",
    content,
    macroMode: "verbatim",
    origin: "generated",
    sourceVersionId: null,
    direction: null,
    hidden: false,
    starred: false,
    createdAt: 0,
    error: null,
    rowVersion: 1
  }) as unknown as Version

const entry = (slot: string, parent: string | null, v: Version, rowVersion = 1) =>
  ({
    slotId: slot as SlotId,
    laneId: "lane",
    parentSlotId: parent as SlotId | null,
    depth: parent === null ? 0 : 1,
    rowVersion,
    contextExcluded: false,
    version: v,
    versionCount: 1,
    inContext: v.content.length > 0
  }) as unknown as PathEntry

const window = (entries: Array<PathEntry>) =>
  ({ leafSlotId: entries.at(-1)!.slotId, entries, older: null, newer: null }) as unknown as PathWindow

/** A session whose reads wait until the test answers them. */
const session = () => {
  const s = new ChatSession(chatId, null, AtomRegistry.make())
  const answers: Array<(window: PathWindow) => void> = []
  const internals = s as unknown as {
    read: () => Promise<PathWindow>
    call: () => Promise<unknown>
    receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
  }
  internals.read = () => new Promise((answer) => answers.push(answer))
  internals.call = () => Promise.resolve({ ok: true, value: chat })
  return { s, answers, receive: (event: ChatEvent) => internals.receive([event], null) }
}

const first = entry("s1", null, version("v1", "s1", "complete", "Hello."))
const reply = version("v2", "s2", "generating", "The tide")
const second = entry("s2", "s1", reply)

describe("ChatSession", () => {
  it("keeps a message that arrived while the window was being read", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    // Sent from another tab after the server read the window, before the reply got here.
    receive({ _tag: "Slot", entry: entry("s3", "s2", version("v3", "s3", "complete", "Again.")) })
    answers[0]!(window([first, second]))
    await opening
    expect(s.snapshot().entries.map((e) => e.slotId)).toEqual(["s1", "s2", "s3"])
  })

  it("keeps a reply that finished while the window was being read", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    receive({ _tag: "Version", version: version("v2", "s2", "complete", "The tide turned.") })
    answers[0]!(window([first, second]))
    await opening
    const shown = s.snapshot().entries[1]!.version
    expect(shown.status).toBe("complete")
    expect(shown.content).toBe("The tide turned.")
  })

  it("doesn't let an event older than the window undo it", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    // The slot event that started the reply, arriving late; the window already has it finished.
    receive({ _tag: "Slot", entry: second })
    answers[0]!(window([first, entry("s2", "s1", version("v2", "s2", "complete", "The tide turned."))]))
    await opening
    expect(s.snapshot().entries[1]!.version.status).toBe("complete")
  })
})
