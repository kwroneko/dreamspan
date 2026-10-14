// A chat session's window against events that arrive while a read is in flight: the
// server may answer the read from before them, and the reply mustn't undo them.
import type { Chat, ChatId, PathEntry, QueuedMessage, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent, PathWindow } from "@rp/shared/chatApi.ts"
import { AtomRegistry } from "effect/reactivity"
import { describe, expect, it, vi } from "vitest"

// rpc.ts reads the page's location when imported.
vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession, liveReasoning, liveText } = await import("../src/features/chat/session.ts")

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
    mark: null,
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
    hiddenByUser: false,
    version: v,
    versionCount: 1,
    inContext: v.content.length > 0
  }) as unknown as PathEntry

const window = (entries: Array<PathEntry>) =>
  ({ leafSlotId: entries.at(-1)!.slotId, entries, older: null, newer: null }) as unknown as PathWindow

/** A session whose reads wait until the test answers them. */
const session = () => {
  const registry = AtomRegistry.make()
  const s = new ChatSession(chatId, null, registry, "user")
  const answers: Array<(window: PathWindow) => void> = []
  const internals = s as unknown as {
    read: () => Promise<PathWindow>
    refreshContext: () => Promise<void>
    refreshEditors: () => Promise<void>
    call: () => Promise<unknown>
    receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
    flush: () => void
  }
  internals.refreshContext = async () => {}
  // The message editors' drafts are read with their own call, which the stub doesn't answer.
  internals.refreshEditors = async () => {}
  internals.read = () => new Promise((answer) => answers.push(answer))
  internals.call = () => Promise.resolve({ ok: true, value: chat })
  return {
    s,
    registry,
    answers,
    receive: (event: ChatEvent) => internals.receive([event], null),
    flush: () => internals.flush()
  }
}

const first = entry("s1", null, version("v1", "s1", "complete", "Hello."))
const reply = version("v2", "s2", "generating", "The tide")
const second = entry("s2", "s1", reply)

describe("ChatSession", () => {
  it("appends reasoning to a continuation's saved reasoning independently of text", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { s, registry, answers, receive, flush } = session()
    const opening = s.open(null)
    answers[0]!(window([first, entry("s2", "s1", { ...reply, reasoning: "Plan one." } as Version)]))
    await opening
    receive({ _tag: "Reasoning", versionId: reply.id, offset: 9, text: " Plan two." })
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: " turned." })
    flush()
    expect(registry.get(liveReasoning(reply.id))).toBe("Plan one. Plan two.")
    expect(registry.get(liveText(reply.id))).toBe("The tide turned.")
    // A repeated delta does not duplicate reasoning, and finishing removes both live atoms.
    receive({ _tag: "Reasoning", versionId: reply.id, offset: 9, text: " Plan two." })
    receive({ _tag: "Version", version: { ...reply, status: "complete", reasoning: "Plan one. Plan two." } as Version })
    expect(s.snapshot().entries[1]!.version.reasoning).toBe("Plan one. Plan two.")
    expect(registry.get(liveReasoning(reply.id))).toBeNull()
    expect(registry.get(liveText(reply.id))).toBeNull()
  })

  it("loads live reasoning from Hello before a window arrives", async () => {
    const { s, registry, answers, receive } = session()
    receive({
      _tag: "Hello",
      live: [{ versionId: reply.id, text: "The tide turned", reasoning: "Plan one. Plan two." }]
    })
    answers[0]!(window([first, entry("s2", "s1", { ...reply, reasoning: "Plan one." } as Version)]))
    await vi.waitFor(() => expect(s.snapshot().entries).toHaveLength(2))
    expect(registry.get(liveReasoning(reply.id))).toBe("Plan one. Plan two.")
    expect(s.snapshot().entries[1]!.version.id).toBe(reply.id)
  })

  it("invalidates history for changes outside the window and reloads, without token updates or read replay", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { s, answers, receive } = session()
    const opening = s.open(null)
    const revision = s.snapshot().pathRevision
    receive({ _tag: "Slot", entry: first })
    expect(s.snapshot().pathRevision).toBe(revision + 1)
    // Replaying that event after an in-flight read isn't another history change.
    answers[0]!(window([first, second]))
    await opening
    expect(s.snapshot().pathRevision).toBe(revision + 1)
    receive({ _tag: "Version", version: version("old-version", "old-slot", "complete", "Outside the window.") })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    receive({ _tag: "Delta", versionId: reply.id, offset: reply.content.length, text: " rises" })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    receive({ _tag: "Cache", leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    // Deletion/restoration and reconnects reload even when the tip doesn't move.
    receive({ _tag: "Reload" })
    expect(s.snapshot().pathRevision).toBe(revision + 3)
    answers[1]!(window([first, second]))
    await Promise.resolve()
    s.dispose()
  })

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

  it("doesn't let a queue read older than a Queue event bring back what it removed", async () => {
    const s = new ChatSession(chatId, null, AtomRegistry.make(), "user")
    const internals = s as unknown as {
      call: () => Promise<unknown>
      refreshQueue: () => Promise<void>
      receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
    }
    let answer!: (value: unknown) => void
    internals.call = () => new Promise((resolve) => (answer = resolve))
    const reading = internals.refreshQueue()
    // The server read the queue, then something queued; the event beats the read's reply.
    const queued = { id: "q1", content: "new", rowVersion: 1 } as unknown as QueuedMessage
    internals.receive([{ _tag: "Queue", queue: [queued] }], null)
    answer({ ok: true, value: [] })
    await reading
    expect(s.snapshot().queue.map((q) => q.content)).toEqual(["new"])
  })

  it("notifies prospective default readers even when a Cache event leaves effective context unchanged", () => {
    const { s, receive } = session()
    const changed = vi.fn()
    const unsubscribe = s.subscribeContext(changed)
    const event = {
      _tag: "Cache",
      leafSlotId: null,
      warmth: null,
      historyStart: null,
      summarizedThrough: null
    } as const
    receive(event)
    const history = s.snapshot().history
    receive(event)
    expect(s.snapshot().history).toBe(history)
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    receive(event)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
