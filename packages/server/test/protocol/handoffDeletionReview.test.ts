import { composerCarryCopy } from "../../../client/src/features/chat/composerCarry.ts"
import type { ChatSession } from "../../../client/src/features/chat/session.ts"
import type { Copy } from "../../../client/src/features/editor/backup.ts"
import { assert, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect } from "effect"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { ComposerDraft } from "../../../client/src/features/chat/composerDraft.ts"
import { makeCopy } from "../../../client/src/features/editor/backup.ts"
import { Generator } from "../../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "../support/config.ts"
const copies = vi.hoisted(() => new Map<string, Copy>())
vi.mock("../../../client/src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../../../client/src/features/editor/backup.ts")>()),
  copiesOfUser: async () => [...copies.values()],
  keepCopy: async (c: Copy, p?: Copy | null) => {
    copies.set(c.key, c)
    if (p) copies.delete(p.key)
  },
  dropCopy: async (c: Copy) => {
    copies.delete(c.key)
  }
}))
for (const kind of ["legacy", "stale", "fresh"] as const)
  it.live(`a ${kind} first-send handoff respects a real composer deletion`, () =>
    Effect.gen(function* () {
      copies.clear()
      const api = yield* client()
      const owner = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Synthetic old first-send handoff" })
      const opened = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const old = yield* api.SaveComposer({
        chatId: chat.id,
        draftId: opened.id,
        rowVersion: opened.rowVersion,
        session: opened.session,
        next: false,
        operationId: uuidv7(),
        content: "deleted handoff text"
      })
      const cleared = yield* api.SaveComposer({
        chatId: chat.id,
        draftId: opened.id,
        rowVersion: old.draft!.rowVersion,
        session: old.draft!.session,
        next: false,
        operationId: uuidv7(),
        content: ""
      })
      assert.isAbove(cleared.draft!.clearedVersion!, 0)
      const content = kind === "fresh" ? "fresh last keystroke" : "deleted handoff text"
      const copy =
        kind === "legacy"
          ? makeCopy(
              owner,
              "pending-chat:synthetic",
              "first message",
              {
                kind: "pendingChat",
                payload: { entityId: "synthetic", name: "Synthetic", chatId: chat.id, content }
              },
              1
            )
          : composerCarryCopy(
              owner,
              chat.id,
              "synthetic",
              "Synthetic",
              content,
              null,
              kind === "fresh" ? cleared.draft! : opened
            )
      copies.set(copy.key, copy)
      const session = {
        id: chat.id,
        snapshot: () => ({ forkId: chat.currentForkId }),
        call: async (
          fn: (
            client: (tag: "OpenComposer" | "SaveComposer", p: never) => Effect.Effect<unknown, unknown>
          ) => Effect.Effect<unknown, unknown>
        ) => ({ ok: true, value: await Effect.runPromise(fn((tag, p) => api[tag](p))) })
      }
      const store = new ComposerDraft(session as unknown as ChatSession, owner, {
        setTimer: () => 0,
        clearTimer: () => {},
        now: () => 100000,
        keepalive: async () => false
      })
      store.setFork(null, false)
      yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(store.snapshot().ready)))
      const server = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      assert.strictEqual(server.content, kind === "fresh" ? content : "")
      assert.strictEqual(copies.has(copy.key), kind !== "fresh")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
