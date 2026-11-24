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
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async () => [...copies.values()],
  copiesOfUser: async () => [...copies.values()],
  keepCopy: async (c: Copy, p?: Copy | null) => {
    copies.set(c.key, c)
    if (p) copies.delete(p.key)
  },
  dropCopy: async (c: Copy) => {
    copies.delete(c.key)
  }
}))
import { carryLeftover, ComposerDraft, takeLeftover } from "../src/features/chat/composerDraft.ts"

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
const chat = (chatId: string, calls: Array<Call>, swept: () => boolean) => {
  const session = {
    id: chatId as ChatId,
    snapshot: () => ({ forkId: "fork" }),
    call: async (fn: (client: Client) => Effect.Effect<unknown, unknown>) => {
      const result = await Effect.runPromiseExit(
        fn((tag, payload) => {
          calls.push({ tag, payload })
          if (tag === "OpenComposer") return swept() ? Effect.fail("NotFound") : Effect.succeed(draftOf(chatId))
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
    now: () => 100000,
    keepalive: async () => false
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
  expect(takeLeftover("old")).toBeNull()
})

it("what's typed after the stop is there to file once as the tab leaves", async () => {
  const old = await stopped([])
  old.type("Typed after the stop, then the tab closed.")
  const left = takeLeftover("old")
  expect(left?.content).toBe("Typed after the stop, then the tab closed.")
  expect(left?.save.chatId).toBe("old")
  expect(takeLeftover("old")).toBeNull()
})

it("nothing is left when the box holds only what the sweep filed", async () => {
  await stopped([])
  expect(takeLeftover("old")).toBeNull()
})
