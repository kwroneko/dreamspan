// Inserting messages in the client (spec/MESSAGE-INSERT.md §4, unit 9): which message actions
// are offered where, the editor's estimate lines and default speaker, and how an open chat
// places an inserted message and renumbers what follows it, whichever tab inserted it.
import type { Chat, ChatId, EntityId, ForkId, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent, PathWindow } from "@rp/shared/chatApi.ts"
import { Cast } from "@rp/shared/chatSetupApi.ts"
import { AtomRegistry } from "effect/reactivity"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession } = await import("../src/features/chat/session.ts")
const { availableMessageActions, messageActions } = await import("../src/features/chat/messageActions.tsx")
const insert = await import("../src/features/chat/insertMessage/index.tsx")
const { cacheLine, historyStartLine, summarizedLine, insertPosition } =
  await import("../src/features/chat/insertMessage/estimates.ts")
const { insertSpeakerDefault, pickInsertSpeaker, insertSpeakerDefaults } =
  await import("../src/features/chat/insertMessage/speakerDefault.ts")
type Session = InstanceType<typeof ChatSession>
type ActionContext = Parameters<typeof availableMessageActions>[0]

const chatId = "chat-1" as ChatId
const fork = "fork-1" as ForkId
const chat = { id: chatId, currentForkId: fork, rowVersion: 3 } as unknown as Chat
const MIRA = "mira" as EntityId
const TOBIN = "tobin" as EntityId

const version = (slotId: string, status: Version["status"] = "complete", speaker: EntityId | null = MIRA) =>
  ({
    id: `v-${slotId}` as VersionId,
    slotId: slotId as SlotId,
    status,
    speakerEntityId: speaker,
    writer: speaker === TOBIN ? "human" : "model",
    content: `text of ${slotId}`,
    origin: "generated",
    rowVersion: 1
  }) as unknown as Version

const entry = (
  slot: string,
  parent: string | null,
  depth: number,
  options: { position?: number; inserted?: boolean; speaker?: EntityId | null; status?: Version["status"] } = {}
) =>
  ({
    slotId: slot as SlotId,
    laneId: "lane",
    parentSlotId: parent as SlotId | null,
    depth,
    rowVersion: 1,
    contextExcluded: false,
    hiddenByUser: false,
    version: version(slot, options.status, options.speaker === undefined ? MIRA : options.speaker),
    versionCount: 1,
    branchCount: 1,
    branchIndex: 0,
    forkId: fork,
    shownForkId: fork,
    side: options.speaker === TOBIN ? "user" : "assistant",
    firstSpeakerEntityId: null,
    inContext: true,
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.inserted ? { inserted: true } : {})
  }) as unknown as PathEntry

/** a, b (the user's), c: a fork without insertions, read without positions. */
const a = entry("a", null, 0)
const b = entry("b", "a", 1, { speaker: TOBIN })
const c = entry("c", "b", 2)

const pathWindow = (entries: ReadonlyArray<PathEntry>, leaf: string | null, older: string | null = null) =>
  ({ leafSlotId: leaf, forkId: fork, entries, older, newer: null }) as unknown as PathWindow

const session = async (
  entries: ReadonlyArray<PathEntry> = [a, b, c],
  leaf: string | null = "c",
  older: string | null = null
) => {
  const s = new ChatSession(chatId, null, AtomRegistry.make(), "user")
  const internals = s as unknown as {
    read: () => Promise<PathWindow>
    refreshContext: () => Promise<void>
    refreshEditors: () => Promise<void>
    refreshCast: () => Promise<void>
    refreshQueue: () => Promise<void>
    call: (rpc: unknown) => Promise<unknown>
    receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
  }
  internals.refreshContext = async () => {}
  internals.refreshEditors = async () => {}
  internals.refreshCast = async () => {}
  internals.refreshQueue = async () => {}
  internals.read = async () => pathWindow(entries, leaf, older)
  internals.call = async () => ({ ok: true, value: chat })
  await s.open(null)
  return {
    s,
    setWindow: (window: PathWindow) => {
      internals.read = async () => window
    },
    receive: (event: ChatEvent) => internals.receive([event], null)
  }
}

const shown = (s: Session) => s.snapshot().entries.map((e) => [e.slotId, e.position ?? e.depth])

describe("an open chat places inserted messages", () => {
  it("directly below the anchor, renumbering what follows, the newest first", async () => {
    const { s, receive } = await session()
    receive({ _tag: "Slot", entry: entry("x1", "a", 1, { position: 1, inserted: true }) })
    expect(shown(s)).toEqual([
      ["a", 0],
      ["x1", 1],
      ["b", 2],
      ["c", 3]
    ])
    // Inserted below `a` again: directly below it, above the first one.
    receive({ _tag: "Slot", entry: entry("x2", "a", 1, { position: 1, inserted: true }) })
    // Below the first inserted message.
    receive({ _tag: "Slot", entry: entry("x3", "x1", 2, { position: 3, inserted: true }) })
    expect(shown(s)).toEqual([
      ["a", 0],
      ["x2", 1],
      ["x1", 2],
      ["x3", 3],
      ["b", 4],
      ["c", 5]
    ])
    // The tip stays the fork's: an inserted message is never the leaf appends go below.
    expect(s.snapshot().leafSlotId).toBe("c")
  })

  it("uses the server order when older sibling events arrive after newer ones", async () => {
    const h = await session()
    const older = entry("x1", "a", 1, { position: 1, inserted: true })
    const newer = entry("x2", "a", 1, { position: 1, inserted: true })
    // Both writes committed before either event: each had position 1 when committed.
    h.setWindow(pathWindow([a, newer, { ...older, position: 2 }, { ...b, position: 3 }, { ...c, position: 4 }], "c"))
    h.receive({ _tag: "Slot", entry: newer })
    h.receive({ _tag: "Slot", entry: older })
    await vi.waitFor(() =>
      expect(shown(h.s)).toEqual([
        ["a", 0],
        ["x2", 1],
        ["x1", 2],
        ["b", 3],
        ["c", 4]
      ])
    )
    h.s.dispose()
  })

  it("recovers a child whose insertion event precedes its anchor's event", async () => {
    const h = await session()
    const parent = entry("x1", "a", 1, { position: 1, inserted: true })
    const child = entry("x2", "x1", 2, { position: 2, inserted: true })
    h.setWindow(pathWindow([a, parent, child, { ...b, position: 3 }, { ...c, position: 4 }], "c"))
    h.receive({ _tag: "Slot", entry: child })
    h.receive({ _tag: "Slot", entry: parent })
    await vi.waitFor(() =>
      expect(shown(h.s)).toEqual([
        ["a", 0],
        ["x1", 1],
        ["x2", 2],
        ["b", 3],
        ["c", 4]
      ])
    )
    h.s.dispose()
  })

  it("never promotes an unknown inserted slot without a position to the structural tip", async () => {
    const h = await session([], null)
    const x = entry("x", null, 0, { inserted: true })
    h.setWindow(pathWindow([{ ...x, position: 0 }], null))
    h.receive({ _tag: "Slot", entry: x })
    await vi.waitFor(() => {
      expect(shown(h.s)).toEqual([["x", 0]])
      expect(h.s.snapshot().leafSlotId).toBeNull()
    })
    h.s.dispose()
  })

  it("keeps its place when the same event comes again, or a slot event without a position", async () => {
    const { s, receive } = await session()
    const x = entry("x", "b", 2, { position: 2, inserted: true })
    receive({ _tag: "Slot", entry: x })
    receive({ _tag: "Slot", entry: x })
    // Its later events (a swipe, an edit) are read with GetSlot, which has no position.
    receive({ _tag: "Slot", entry: { ...entry("x", "b", 2, { inserted: true }), rowVersion: 2 } as PathEntry })
    expect(shown(s)).toEqual([
      ["a", 0],
      ["b", 1],
      ["x", 2],
      ["c", 3]
    ])
  })

  it("above the first message, and above the window only renumbers", async () => {
    const top = await session()
    top.receive({ _tag: "Slot", entry: entry("x", null, 0, { position: 0, inserted: true }) })
    expect(shown(top.s).map(([id]) => id)).toEqual(["x", "a", "b", "c"])
    // A window starting at `b`: the anchor `a` is above it.
    const later = await session([entry("b", "a", 1), entry("c", "b", 2)], "c", "a")
    later.setWindow(
      pathWindow(
        [
          { ...b, position: 2 },
          { ...c, position: 3 }
        ],
        "c",
        "x"
      )
    )
    const event = { _tag: "Slot", entry: entry("x", "a", 1, { position: 1, inserted: true }) } as const
    later.receive(event)
    await vi.waitFor(() =>
      expect(shown(later.s)).toEqual([
        ["b", 2],
        ["c", 3]
      ])
    )
    later.receive(event)
    expect(shown(later.s)).toEqual([
      ["b", 2],
      ["c", 3]
    ])
    later.s.dispose()
  })

  it("ignores another fork's insertion", async () => {
    const { s, receive } = await session()
    receive({
      _tag: "Slot",
      entry: { ...entry("x", "a", 1, { position: 1, inserted: true }), forkId: "other", shownForkId: "other" } as never
    })
    expect(shown(s).map(([id]) => id)).toEqual(["a", "b", "c"])
  })

  it("appends after an above-first insertion while the structural tip is null", async () => {
    const x = entry("x", null, 0, { position: 0, inserted: true })
    const h = await session([x], null)
    h.receive({ _tag: "Slot", entry: entry("root", null, 0) })
    expect(shown(h.s)).toEqual([
      ["x", 0],
      ["root", 1]
    ])
    expect(h.s.snapshot().leafSlotId).toBe("root")
    h.s.dispose()
  })

  it("appends below the tip after an inserted message shown last", async () => {
    // The tip `c`, then `x` inserted below it: a message appended in another tab goes below `c`.
    const { s, receive } = await session([a, b, c, entry("x", "c", 3, { position: 3, inserted: true })], "c")
    receive({ _tag: "Slot", entry: entry("d", "c", 3) })
    expect(shown(s)).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["x", 3],
      ["d", 4]
    ])
    expect(s.snapshot().leafSlotId).toBe("d")
  })
})

describe("the insertion actions", () => {
  let dispose: Array<() => void> = []
  beforeEach(() => {
    dispose = insert.register()
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })
  const offered = (s: Session, target: PathEntry, generating = false) =>
    availableMessageActions({
      entry: target,
      session: s,
      branchFork: null,
      generated: true,
      generating,
      hidden: false,
      report: () => {},
      toast: () => {}
    } as ActionContext)
      .map((action) => action.id)
      .filter((id) => id.startsWith("message.insert") || id === "message.duplicate")

  it("offers Insert below on every message, Insert above on the first shown only, and Duplicate", async () => {
    const { s } = await session()
    expect(offered(s, a)).toEqual(["message.insert-above", "message.insert-below", "message.duplicate"])
    expect(offered(s, b)).toEqual(["message.insert-below", "message.duplicate"])
    // A window that doesn't start at the first message has no first message to insert above.
    const later = await session([b, c], "c", "a")
    expect(offered(later.s, b)).toEqual(["message.insert-below", "message.duplicate"])
    expect(messageActions.get("message.insert-below")!.order).toBe(28)
  })

  it("disables Duplicate, with the reason, for a failed or generating version", async () => {
    const { s } = await session()
    const context = (target: PathEntry, generating = false) =>
      ({ entry: target, session: s, generating }) as unknown as ActionContext
    expect(insert.duplicateRefusal(context(a))).toBeNull()
    expect(insert.duplicateRefusal(context(entry("f", "a", 1, { status: "failed" })))).toBe(
      "A failed version has nothing to duplicate."
    )
    expect(insert.duplicateRefusal(context(entry("g", "a", 1, { status: "generating" }), true))).toBe(
      "It's still being written. Duplicate it once it's finished."
    )
  })
})

describe("the insertion editor's lines and speaker", () => {
  const view = (change: Record<string, unknown>) =>
    ({
      entries: [a, b, c],
      newer: null,
      leafSlotId: "c",
      cache: null,
      history: null,
      lcm: null,
      ...change
    }) as never

  it("says what the next reply re-reads, before the history start, and inside a summary", () => {
    const now = 1_000
    const warm = { changed: null, ttlS: 300, expiresAt: 2_000, prefixTokens: 1234 }
    expect(cacheLine({ view: view({ cache: warm }), anchor: a, position: insertPosition(a), now })).toBe(
      "The model will re-read 3 messages on the next reply (cache: ~1,234 tokens)."
    )
    expect(cacheLine({ view: view({}), anchor: b, position: insertPosition(b), now })).toBe(
      "The model will re-read 2 messages on the next reply (the cache is cold)."
    )
    const history = { leafSlotId: "c", historyStart: { slotId: "b", depth: 1 } }
    const before = { view: view({ history }), anchor: a, position: insertPosition(a), now }
    expect(historyStartLine(before)).toBe("Before the model's history start: the next reply won't see it.")
    expect(cacheLine(before)).toBeNull()
    expect(historyStartLine({ ...before, anchor: b, position: insertPosition(b) })).toBeNull()
    const lcm = {
      enabled: true,
      leafSlotId: "c",
      layer: [{ from: 1, to: 2 }],
      cursorDepth: 1
    }
    expect(summarizedLine({ view: view({ lcm }), anchor: b, position: 2, now })).toBe(
      "Inside summarized history: the summary is rewritten on the next reply."
    )
    // Summarized, it isn't lost before the history start: the rewritten summary carries it.
    const summarized = {
      view: view({ lcm, history: { leafSlotId: "c", historyStart: { slotId: "c", depth: 2 } } }),
      now
    }
    expect(historyStartLine({ ...summarized, anchor: a, position: 1 })).toBeNull()
    expect(cacheLine({ ...summarized, anchor: a, position: 1 })).not.toBeNull()
    expect(summarizedLine({ view: view({ lcm }), anchor: c, position: 3, now })).toBeNull()
  })

  it("speaks as the composer's speaker below a character, else as the character before", () => {
    const cast = new Cast({
      slotId: null,
      participants: [MIRA],
      absent: [],
      playedByMe: [TOBIN],
      model: null,
      preset: null,
      lorebooks: [],
      cardLorebooksOff: [],
      globalLorebooksOff: [],
      loreBelowHistory: true,
      macroBindings: {},
      macroNames: { user: "Tobin", char: "Mira" },
      rolesProjection: null,
      roleProjections: [],
      cards: []
    })
    const context = { entries: [a, b, c], cast, composerSpeaker: TOBIN }
    expect(insertSpeakerDefault({ ...context, anchor: a })).toBe(TOBIN)
    expect(insertSpeakerDefault({ ...context, anchor: b })).toBe(MIRA)
    // A plugin's default replaces it.
    const close = insertSpeakerDefaults.register({ id: "test.speaker", order: 0, pick: () => MIRA })
    expect(pickInsertSpeaker({ ...context, anchor: a })).toBe(MIRA)
    close()
  })
})
