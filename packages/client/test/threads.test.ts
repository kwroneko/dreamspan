// Parallel threads in the client (spec/THREADS.md §5.1, §13, TH3): what the dialog decides and
// says, which forks the branch list leaves out, the shared reads of a fork's sets, and the
// registered parts that read them. Synthetic ids only.
import type { ChatId, EntityId, Fork, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ThreadSet } from "@rp/shared/threads.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { branchControlParts } from "../src/features/chat/branchParts.ts"
import type { ChatSession, ChatView } from "../src/features/chat/session.ts"
import { messageRows, timelineTransforms } from "../src/features/chat/timelineContributions.tsx"
import { register } from "../src/features/threads/index.tsx"
import {
  defaultWritesAs,
  initialThreads,
  listedAsBranch,
  otherSplits,
  playedLine,
  startCast,
  startProblem,
  startRequest,
  threadName
} from "../src/features/threads/model.ts"
import { offeredThreads, resetTicks, setTick, ticksOf } from "../src/features/threads/sendTargets.ts"
import { UNDO_HINT } from "../src/features/threads/ThreadsSection.tsx"
import { loadThreadSets, resetThreadSets, threadSetsNow } from "../src/features/threads/threadSets.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const id = (name: string) => name as EntityId
const [mira, tobin, wren, ash, narrator] = ["mira", "tobin", "wren", "ash", "narrator"].map(id) as [
  EntityId,
  EntityId,
  EntityId,
  EntityId,
  EntityId
]
const names: Record<string, string> = { mira: "Mira", tobin: "Tobin", wren: "Wren", ash: "Ash", narrator: "Narrator" }
const nameOf = (entity: EntityId) => names[entity] ?? null

const set: ThreadSet = {
  splitId: "split-1",
  slotId: "slot-39" as SlotId,
  position: 39,
  forkId: "fork-f" as ForkId,
  createdAt: 1,
  self: 0,
  threads: [
    {
      ordinal: 0,
      forkId: "fork-f" as ForkId,
      starts: false,
      name: "At the Lantern",
      nameUser: true,
      openForkId: "fork-f" as ForkId,
      forks: 1,
      cast: [mira, tobin],
      rowVersion: 1
    },
    {
      ordinal: 1,
      forkId: "fork-w" as ForkId,
      starts: true,
      name: null,
      nameUser: false,
      openForkId: "fork-w" as ForkId,
      forks: 1,
      cast: [wren],
      rowVersion: 1
    }
  ]
}

describe("what the threads' surfaces say", () => {
  it("names a thread by its name, else its characters, else its number", () => {
    expect(threadName(set.threads[0]!, nameOf)).toBe("At the Lantern")
    expect(threadName(set.threads[1]!, nameOf)).toBe("Wren")
    expect(threadName({ ...set.threads[1]!, cast: [mira, tobin, wren] }, nameOf)).toBe("Mira, Tobin and Wren")
    expect(threadName({ ...set.threads[1]!, cast: [] }, nameOf)).toBe("Thread 2")
  })

  it("lists another thread's forks apart from the branches, from inside a set and outside it", () => {
    const lantern = { threads: [{ splitId: "split-1", ordinal: 0 }] }
    const docks = { threads: [{ splitId: "split-1", ordinal: 1 }] }
    const plain = {}
    // In the Lantern: its own alternates and plain branches are branches; the docks is a thread.
    expect(listedAsBranch(lantern, lantern)).toBe(true)
    expect(listedAsBranch(plain, lantern)).toBe(true)
    expect(listedAsBranch(docks, lantern)).toBe(false)
    // In a branch outside the set: both threads are threads, never branches.
    expect(listedAsBranch(lantern, plain)).toBe(false)
    expect(listedAsBranch(docks, undefined)).toBe(false)
    // A nested set inside the docks: the docks' own fork is a branch there, the inner one's thread isn't.
    const inner = {
      threads: [
        { splitId: "split-2", ordinal: 1 },
        { splitId: "split-1", ordinal: 1 }
      ]
    }
    expect(listedAsBranch(docks, { threads: [{ splitId: "split-2", ordinal: 0 }, ...docks.threads] })).toBe(true)
    expect(listedAsBranch(inner, { threads: [{ splitId: "split-2", ordinal: 0 }, ...docks.threads] })).toBe(false)
    expect(
      otherSplits(
        [
          { id: "a" as ForkId, threads: lantern.threads },
          { id: "b" as ForkId, threads: inner.threads },
          { id: "c" as ForkId }
        ],
        new Set(["split-1"])
      )
    ).toEqual([{ splitId: "split-2", forkId: "b" }])
  })

  it("opens the dialog with everyone in This branch and nobody yet in the new thread", () => {
    const cast = startCast({
      participants: [mira, tobin, wren, narrator],
      playedByMe: [ash],
      roles: { narrator: "narrator" }
    })
    expect(cast).toEqual({
      narrators: [narrator],
      members: [mira, tobin, wren],
      mine: [ash],
      characters: [mira, tobin, wren]
    })
    const rows = initialThreads(cast)
    expect(rows.map((row) => row.cast)).toEqual([[mira, tobin, wren, ash], []])
    // With a narrator, an empty thread is still someone's: the narrator is in every thread.
    expect(startProblem(rows, cast)).toBeNull()
    const plain = startCast({ participants: [mira, tobin, wren], playedByMe: [ash] })
    expect(startProblem(initialThreads(plain), plain)).toBe("Thread 2 has no character in it.")
    expect(startProblem(initialThreads(plain).slice(0, 1), plain)).toBe("Start at least two threads.")
    const moved = [
      { ...initialThreads(plain)[0]!, cast: [mira, tobin, ash] },
      { key: 1, name: " At the docks ", cast: [wren], writesAs: null }
    ]
    expect(startProblem(moved, plain)).toBeNull()
    // Writes as: one of the user's cards in it, else a narrator, else its first character.
    expect(defaultWritesAs({ cast: [wren, ash] }, plain)).toBe(ash)
    expect(defaultWritesAs({ cast: [wren] }, cast)).toBe(narrator)
    expect(defaultWritesAs({ cast: [wren] }, plain)).toBe(wren)
    expect(startRequest(moved, plain)).toEqual([
      { name: null, cast: [mira, tobin, ash], writesAs: null },
      { name: "At the docks", cast: [wren], writesAs: wren }
    ])
  })

  it("allows a thread whose only cast character is played by the user", () => {
    const cast = startCast({ participants: [mira, ash], playedByMe: [ash] })
    const rows = initialThreads(cast)
    expect(
      startProblem(
        [
          { ...rows[0]!, cast: [mira] },
          { ...rows[1]!, cast: [ash] }
        ],
        cast
      )
    ).toBeNull()
    // A persona outside the cast still needs a cast character, matching StartThreads.
    const persona = startCast({ participants: [mira], playedByMe: [ash] })
    expect(
      startProblem(
        [
          { ...rows[0]!, cast: [mira] },
          { ...rows[1]!, cast: [ash] }
        ],
        persona
      )
    ).not.toBeNull()
  })

  it("does not promise existing absences disappear when nobody moves", () => {
    expect(playedLine(2, 5, [])).not.toContain("everyone stays there")
  })

  it("Undo tells players the continuing messages and descendant branches stay", () => {
    expect(UNDO_HINT).toContain("keeps its messages")
    expect(UNDO_HINT).toContain("Branches made from")
    expect(UNDO_HINT).not.toContain("as it was before")
  })

  it("says the moved speaker still knows its own messages", () => {
    expect(playedLine(2, 5, ["Wren"])).toContain("own messages")
  })

  it("says what happens to the messages after an earlier message", () => {
    expect(playedLine(39, 53, ["Wren"])).toBe(
      "#41–#54 become this branch’s thread. Wren counts as not there for them, in this branch only. They still know their own messages."
    )
    expect(playedLine(39, 40, ["Wren", "Tobin"])).toBe(
      "#41 becomes this branch’s thread. Wren and Tobin count as not there for them, in this branch only. They still know their own messages."
    )
    expect(playedLine(39, null, [])).toBe(
      "The messages after #40 become this branch’s thread. Nobody is marked away for them. Who was there stays as recorded."
    )
  })
})

describe("a fork's sets, read once and shared", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    resetThreadSets()
    dispose = register()
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
    resetThreadSets()
  })
  // Each fork reads the set as the server would answer it: which of its threads it's in.
  const session = (sets: ReadonlyArray<ThreadSet>) => {
    const call = vi.fn(async (rpc: (client: (tag: string, payload: { forkId: string }) => null) => unknown) => {
      let asked = ""
      rpc((_tag, payload) => {
        asked = payload.forkId
        return null
      })
      return { ok: true as const, value: sets.map((s) => ({ ...s, self: asked === "fork-w" ? 1 : 0 })) }
    })
    return { session: { id: "chat-1", call } as unknown as ChatSession, call }
  }

  it("asks once per fork and version, and keeps the last answer while a newer read is on its way", async () => {
    const { session: s, call } = session([set])
    const chat = "chat-1" as never
    const fork = "fork-f" as ForkId
    expect(threadSetsNow(chat, fork)).toBeNull()
    loadThreadSets(s, chat, fork, "1/0")
    loadThreadSets(s, chat, fork, "1/0")
    await vi.waitFor(() => expect(threadSetsNow(chat, fork, "1/0")).toEqual([set]))
    expect(call).toHaveBeenCalledTimes(1)
    loadThreadSets(s, chat, fork, "2/0")
    expect(threadSetsNow(chat, fork, "2/0")).toEqual([set])
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  })

  it("ignores older answers arriving after a newer version without reading that version again", async () => {
    const finish: Array<(result: { ok: true; value: ReadonlyArray<ThreadSet> }) => void> = []
    const call = vi.fn(() => new Promise((resolve) => finish.push(resolve)))
    const s = { id: "chat-1", call } as unknown as ChatSession
    const chat = "chat-1" as never
    const fork = "fork-f" as ForkId
    loadThreadSets(s, chat, fork, "1/0")
    loadThreadSets(s, chat, fork, "2/0")
    finish[1]!({ ok: true, value: [] }) // Undo's answer arrives first.
    await Promise.resolve()
    finish[0]!({ ok: true, value: [set] })
    await Promise.resolve()
    expect(threadSetsNow(chat, fork, "2/0")).toEqual([])
    loadThreadSets(s, chat, fork, "2/0")
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("puts the threads' row after the message they part at, and names the header's trigger", async () => {
    const { session: s } = session([set])
    const chat = { id: "chat-1", currentForkId: "fork-f", rowVersion: 1 }
    const entries = [38, 39, 40].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
    const view = {
      chat,
      forkId: "fork-f",
      entries,
      cast: { cards: [{ entityId: wren, name: "Wren" }] }
    } as unknown as ChatView
    const transform = (v: ChatView) =>
      timelineTransforms
        .list()
        .reduce(
          (rows, entry) =>
            entry.transform(rows, { view: v, lcm: null, summaries: false, divider: -1, historyDivider: -1 }),
          messageRows(entries)
        )
    expect(transform(view).map((row) => row.key)).toEqual(["slot-38", "slot-39", "slot-40"])
    loadThreadSets(s, "chat-1" as never, "fork-f" as ForkId, "1/0")
    await vi.waitFor(() => expect(threadSetsNow("chat-1" as never, "fork-f" as ForkId)).not.toBeNull())
    expect(transform(view).map((row) => row.key)).toEqual(["slot-38", "slot-39", "threads-split-1", "slot-40"])
    const part = branchControlParts.get("threads")!
    const context = { session: s, view, forks: [] as ReadonlyArray<Fork>, shown: undefined }
    expect(part.trigger!(context)).toMatchObject({ kind: "Thread", label: "At the Lantern", icon: "threads" })
    // From the docks: unnamed, called by its characters.
    loadThreadSets(s, "chat-1" as never, "fork-w" as ForkId, "1/0")
    const docks = { ...view, forkId: "fork-w" } as unknown as ChatView
    await vi.waitFor(() => expect(threadSetsNow("chat-1" as never, "fork-w" as ForkId)).not.toBeNull())
    expect(part.trigger!({ ...context, view: docks })).toMatchObject({ label: "Wren" })
    expect(transform(docks).find((row) => row.key === "threads-split-1")).toBeDefined()
  })
})

describe("the threads a send goes to (TH4)", () => {
  afterEach(() => resetTicks())
  const inner: ThreadSet = {
    ...set,
    splitId: "split-2",
    forkId: "fork-w" as ForkId,
    self: 0,
    threads: [
      { ...set.threads[1]!, ordinal: 0, starts: false },
      { ...set.threads[1]!, ordinal: 1, forkId: "fork-x" as ForkId, openForkId: "fork-x" as ForkId, name: "Upstairs" },
      { ...set.threads[1]!, ordinal: 2, forkId: "fork-y" as ForkId, openForkId: null, name: "Gone" }
    ]
  }

  it("offers each other thread with a live fork once, innermost set first, never the one shown", () => {
    // Shown: fork-w, in thread 1 of split-1 and thread 0 of split-2.
    const outer = { ...set, self: 1 }
    const offered = offeredThreads([inner, outer], "fork-w" as ForkId)
    expect(offered.map((other) => [other.key, other.forkId])).toEqual([
      ["split-2:1", "fork-x"],
      ["split-1:0", "fork-f"]
    ])
  })

  it("keeps ticks per fork shown, with whom to write as, until unticked", () => {
    const chat = "chat-1" as ChatId
    setTick(chat, "fork-f" as ForkId, "split-1:1", null)
    setTick(chat, "fork-f" as ForkId, "split-1:1", tobin)
    expect([...ticksOf(chat, "fork-f" as ForkId)]).toEqual([["split-1:1", tobin]])
    expect(ticksOf(chat, "fork-w" as ForkId).size).toBe(0)
    setTick(chat, "fork-f" as ForkId, "split-1:1", undefined)
    expect(ticksOf(chat, "fork-f" as ForkId).size).toBe(0)
  })
})
