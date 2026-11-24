// A composer save that reaches a chat swept meanwhile (a pending chat's tab left open, swept
// elsewhere): the server files the text to recovered texts and has no draft to give back. The box
// must not save again and again, each a fresh operation (rev-draftchats3b #2).
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
import { Effect, Exit } from "effect"
import { expect, it, vi } from "vitest"
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
import { ComposerDraft } from "../src/features/chat/composerDraft.ts"

const draft = new Draft({
  id: "draft",
  key: new DraftKey({ targetKind: "composer", targetId: "chat", field: "fork" }),
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

it("a save filed because its chat was swept doesn't save again", async () => {
  let swept = false
  const calls: Array<string> = []
  const session = {
    id: "chat" as ChatId,
    snapshot: () => ({ forkId: "fork" }),
    call: async (
      fn: (client: (tag: string, payload: unknown) => Effect.Effect<unknown, string>) => Effect.Effect<unknown, unknown>
    ) => {
      const result = await Effect.runPromiseExit(
        fn((tag) => {
          calls.push(tag)
          if (tag === "OpenComposer") return swept ? Effect.fail("NotFound") : Effect.succeed(draft)
          if (tag === "SaveComposer") return Effect.succeed({ draft: null, recovered: true, accepted: false })
          return Effect.fail("unexpected")
        })
      )
      return Exit.isSuccess(result)
        ? { ok: true, value: result.value }
        : { ok: false, error: { tag: "NotFound", message: "gone", problems: [], reason: null } }
    }
  } as unknown as ChatSession
  // A save scheduled at once runs at once; later ones wait for the test.
  const store = new ComposerDraft(session, "user", {
    setTimer: (run, ms) => {
      if (ms === 0) setTimeout(run, 0)
      return 1
    },
    clearTimer: () => {},
    now: () => 100000,
    keepalive: async () => false
  })
  store.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
  swept = true
  store.type("Typed after the sweep.")
  await store.flush()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls.filter((tag) => tag === "SaveComposer")).toHaveLength(1)
})
