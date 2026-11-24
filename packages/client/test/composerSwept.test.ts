// A composer save that reaches a chat swept meanwhile (a pending chat's tab left open, swept
// elsewhere): the server files the text to recovered texts and has no draft to give back. The box
// must not save again and again, each a fresh operation (rev-draftchats3b #2), and what's typed
// after that goes into the fresh chat the tab opens, or is filed once as it leaves.
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
import { Effect, Exit } from "effect"
import { beforeEach, expect, it, vi } from "vitest"
import type { ChatSession } from "../src/features/chat/session.ts"
import type { Copy } from "../src/features/editor/backup.ts"
vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "localhost" }))
const copies = vi.hoisted(() => new Map<string, Copy>())
/**
 * Each transaction that puts a copy aborts (storage full, say): nothing it would put or delete
 * happens. One that only deletes still goes through.
 */
const aborting = vi.hoisted(() => ({ on: false }))
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async () => [...copies.values()],
  copiesOfUser: async () => [...copies.values()],
  keepCopy: async (c: Copy, p?: Copy | null) => {
    if (aborting.on) return
    copies.set(c.key, c)
    if (p) copies.delete(p.key)
  },
  replaceCopies: async (c: Copy, replaced: ReadonlyArray<Copy>) => {
    if (aborting.on) return
    copies.set(c.key, c)
    for (const p of replaced) copies.delete(p.key)
  },
  dropCopy: async (c: Copy) => {
    copies.delete(c.key)
  }
}))
import { carryLeftover, ComposerDraft, fileLeftover, takeLeftover } from "../src/features/chat/composerDraft.ts"

const draftOf = (chatId: string) =>
  new Draft({
    id: `draft-${chatId}`,
    key: new DraftKey({ targetKind: "composer", targetId: chatId, field: "fork" }),
    content: "",
    status: "active",
    rowVersion: 1,
    clearedVersion: 0,
    session: 1,
    baseRevision: null,
    createdAt: 1,
    updatedAt: 1,
    historyLength: 0,
    recovered: 0,
    displaced: null
  })

type Call = { readonly tag: string; readonly payload: Record<string, unknown> }
type Client = (tag: string, payload: Record<string, unknown>) => Effect.Effect<unknown, string>

/** A chat's composer whose saves are filed once `swept` says so. */
const chat = (
  chatId: string,
  calls: Array<Call>,
  swept: () => boolean,
  keepalive: (path: string, body: string) => Promise<boolean> = async () => false,
  saveFails: () => boolean = () => false,
  /** Awaited before a save's answer comes back: the save is on its way meanwhile. */
  answer: () => Promise<void> = async () => {},
  /** The clock of this composer's page. */
  at = 100000
) => {
  const session = {
    id: chatId as ChatId,
    snapshot: () => ({ forkId: "fork" }),
    call: async (fn: (client: Client) => Effect.Effect<unknown, unknown>) => {
      const result = await Effect.runPromiseExit(
        fn((tag, payload) => {
          calls.push({ tag, payload })
          if (tag === "OpenComposer") return swept() ? Effect.fail("NotFound") : Effect.succeed(draftOf(chatId))
          if (tag === "SaveComposer" && saveFails()) return Effect.fail("offline")
          if (tag === "SaveComposer")
            return Effect.succeed(
              swept()
                ? { draft: null, recovered: true, accepted: false }
                : {
                    draft: new Draft({ ...draftOf(chatId), content: payload.content as string, rowVersion: 2 }),
                    recovered: false,
                    accepted: true
                  }
            )
          return Effect.fail("unexpected")
        })
      )
      if (calls.at(-1)?.tag === "SaveComposer") await answer()
      return Exit.isSuccess(result)
        ? { ok: true, value: result.value }
        : { ok: false, error: { tag: "NotFound", message: "gone", problems: [], reason: null } }
    }
  } as unknown as ChatSession
  // A save scheduled at once runs at once; a typing delay waits for `flush`.
  return new ComposerDraft(session, "user", {
    setTimer: (run, ms) => {
      if (ms === 0) setTimeout(run, 0)
      return 1
    },
    clearTimer: () => {},
    now: () => at,
    keepalive
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const saves = (calls: ReadonlyArray<Call>) => calls.filter((call) => call.tag === "SaveComposer")

/** A composer whose chat was swept after it opened, its first save after that filed. */
const stopped = async (calls: Array<Call>) => {
  let swept = false
  const store = chat("old", calls, () => swept)
  store.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
  swept = true
  store.type("Typed before the sweep was known.")
  await store.flush()
  await settle()
  return store
}

beforeEach(() => {
  copies.clear()
  aborting.on = false
  takeLeftover("old")
})

it("a save filed because its chat was swept doesn't save again", async () => {
  const calls: Array<Call> = []
  await stopped(calls)
  expect(saves(calls)).toHaveLength(1)
})

it("what's typed after the stop starts the fresh chat's composer, and is saved there", async () => {
  const calls: Array<Call> = []
  const old = await stopped(calls)
  old.type("Typed before the sweep was known. And after it.")
  await old.flush()
  await settle()
  // Nothing more went to the swept chat.
  expect(saves(calls)).toHaveLength(1)
  carryLeftover("old", "fresh")
  const freshCalls: Array<Call> = []
  const fresh = chat("fresh", freshCalls, () => false)
  fresh.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(fresh.snapshot().ready).toBe(true))
  expect(fresh.snapshot().text).toBe("Typed before the sweep was known. And after it.")
  await fresh.flush()
  await settle()
  expect(saves(freshCalls).map((call) => call.payload.content)).toEqual([
    "Typed before the sweep was known. And after it."
  ])
  expect(takeLeftover("old")).toEqual([])
})

it("what's typed after the stop is there to file once as the tab leaves", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, then the tab closed.")
  const [left, ...more] = takeLeftover("old")
  expect(left?.content).toBe("Typed after the stop, then the tab closed.")
  expect(left?.save.chatId).toBe("old")
  expect(more).toEqual([])
  expect(takeLeftover("old")).toEqual([])
})

it("nothing is left when the box holds only what the sweep filed", async () => {
  await stopped([])
  expect(takeLeftover("old")).toEqual([])
})

const keptFor = (chatId: string) => [...copies.values()].filter((copy) => copy.refId === `composer:${chatId}`)

it("what's typed after the stop is kept in this browser at once, under one save of its own", async () => {
  const old = await stopped([])
  old.type("Typed after the stop.")
  old.type("Typed after the stop, and more.")
  await settle()
  // A reload now finds it in this browser's copies, as the swept chat's composer save.
  const kept = keptFor("old")
  expect(kept.map((copy) => copy.content)).toEqual(["Typed after the stop, and more."])
  const save = kept[0]!.save
  expect(save.kind).toBe("composer")
  if (save.kind === "composer") {
    expect(save.payload.chatId).toBe("old")
    expect(save.payload.operationId).toBe(kept[0]!.key)
  }
  // Cleared again: nothing is kept.
  old.type("")
  await settle()
  expect(keptFor("old")).toEqual([])
})

it("the page going sends what's typed after the stop, and its copy goes once the server has it", async () => {
  const sent: Array<string> = []
  let swept = false
  const store = chat(
    "old",
    [],
    () => swept,
    async (_path, body) => {
      sent.push(body)
      return true
    }
  )
  store.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
  swept = true
  store.type("Filed by the sweep.")
  await store.flush()
  await settle()
  store.type("Filed by the sweep. Typed after it, then the page went.")
  await settle()
  store.beacon()
  await settle()
  expect(sent).toHaveLength(1)
  const body = JSON.parse(sent[0]!) as { composers: Array<{ chatId: string; content: string; operationId: string }> }
  expect(body.composers.map((save) => [save.chatId, save.content])).toEqual([
    ["old", "Filed by the sweep. Typed after it, then the page went."]
  ])
  expect(keptFor("old")).toEqual([])
  // A later send as the tab leaves names the same operation, so the server files it once.
  let again: string | null = null
  fileLeftover("old", async (save) => {
    again = save.operationId
    return { ok: true }
  })
  expect(again).toBe(body.composers[0]!.operationId)
})

it("leaving files what's typed after the stop, and keeps its copy when that fails", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, the tab left offline.")
  await settle()
  fileLeftover("old", async () => ({ ok: false }))
  await settle()
  expect(keptFor("old").map((copy) => copy.content)).toEqual(["Typed after the stop, the tab left offline."])
})

it("what's carried into the fresh chat leaves the swept chat's copy only once the fresh box has it", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, carried.")
  await settle()
  carryLeftover("old", "fresh")
  expect(keptFor("old")).toHaveLength(1)
  const freshCalls: Array<Call> = []
  const fresh = chat("fresh", freshCalls, () => false)
  fresh.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(fresh.snapshot().text).toBe("Typed after the stop, carried."))
  await settle()
  expect(keptFor("old")).toEqual([])
  // The fresh box saved it on its own draft.
  expect(saves(freshCalls).map((call) => call.payload.content)).toEqual(["Typed after the stop, carried."])
})

it("carrying keeps the swept chat's copy when the fresh box's copy and save both fail (rev-dv1 #1)", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, carried while storage and server fail.")
  await settle()
  carryLeftover("old", "fresh")
  aborting.on = true
  const fresh = chat(
    "fresh",
    [],
    () => false,
    undefined,
    () => true
  )
  fresh.setFork("fork" as ForkId, false)
  await vi.waitFor(() =>
    expect(fresh.snapshot().text).toBe("Typed after the stop, carried while storage and server fail.")
  )
  await settle()
  aborting.on = false
  expect(keptFor("old").map((copy) => copy.content)).toEqual([
    "Typed after the stop, carried while storage and server fail."
  ])
})

it("two panes of one swept chat each keep their own text (rev-dv1 #2)", async () => {
  const sent: Array<string> = []
  const keepalive = async (_path: string, body: string) => {
    sent.push((JSON.parse(body) as { composers: Array<{ content: string }> }).composers[0]!.content)
    return false
  }
  const pane = async () => {
    let swept = false
    const store = chat("old", [], () => swept, keepalive)
    store.setFork("fork" as ForkId, false)
    await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
    swept = true
    store.type("Typed before the sweep was known.")
    await store.flush()
    await settle()
    return store
  }
  const first = await pane()
  const second = await pane()
  first.type("Typed in the first pane.")
  second.type("Typed in the second pane.")
  await settle()
  expect(
    keptFor("old")
      .map((copy) => copy.content)
      .sort()
  ).toEqual(["Typed in the first pane.", "Typed in the second pane."])
  // Each pane's page going sends its own text.
  first.beacon()
  second.beacon()
  expect(sent.sort()).toEqual(["Typed in the first pane.", "Typed in the second pane."])
  // Leaving files both, each under its own operation.
  const filed: Array<string> = []
  fileLeftover("old", async (save) => {
    filed.push(save.content)
    return { ok: true }
  })
  expect(filed.sort()).toEqual(["Typed in the first pane.", "Typed in the second pane."])
})

it("text cleared after the sweep leaves no copy to file later (rev-dv1 #3)", async () => {
  let swept = false
  let release = () => {}
  let held = false
  const store = chat(
    "old",
    [],
    () => swept,
    undefined,
    undefined,
    () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve())
  )
  store.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
  swept = true
  held = true
  store.type("Saved as the sweep came.")
  const saving = store.flush()
  await settle()
  // Typed while that save is on its way.
  store.type("Saved as the sweep came. Typed while it was out.")
  await settle()
  held = false
  release()
  await saving
  await settle()
  store.type("")
  await settle()
  expect(keptFor("old")).toEqual([])
})

it("clearing after a replacement copy failed leaves none of the earlier text (rev-dd2 #5)", async () => {
  const old = await stopped([])
  old.type("Text A, typed after the stop.")
  await settle()
  expect(keptFor("old").map((copy) => copy.content)).toEqual(["Text A, typed after the stop."])
  // B's copy can't be put: A's stays.
  aborting.on = true
  old.type("Text A, typed after the stop, and B replacing it.")
  await settle()
  aborting.on = false
  old.type("")
  await settle()
  expect(keptFor("old")).toEqual([])
})

it("a carry opened late isn't also replayed to the swept chat (rev-dd2 #6)", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, carried a minute later.")
  await settle()
  carryLeftover("old", "fresh")
  const freshCalls: Array<Call> = []
  const fresh = chat("fresh", freshCalls, () => false, undefined, undefined, undefined, 100000 + 60_000)
  fresh.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(fresh.snapshot().text).toBe("Typed after the stop, carried a minute later."))
  await settle()
  expect(saves(freshCalls).filter((call) => call.payload.chatId === "old")).toEqual([])
  expect(keptFor("old")).toEqual([])
})
