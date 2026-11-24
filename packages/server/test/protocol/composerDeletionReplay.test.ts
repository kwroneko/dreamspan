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
for (const kind of ["lost clear acknowledgement", "stale text", "lost displacement acknowledgement"] as const)
  it.live(`composer recovery acknowledges ${kind} without reopening deleted text`, () =>
    Effect.gen(function* () {
      copies.clear()
      const api = yield* client()
      const owner = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Synthetic deletion replay" })
      const opened = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const address = { chatId: chat.id, draftId: opened.id, session: opened.session, next: false }
      const written = yield* api.SaveComposer({
        ...address,
        rowVersion: opened.rowVersion,
        operationId: uuidv7(),
        content: "Text deliberately cleared"
      })
      const displacement = makeCopy(
        owner,
        `composer:${chat.id}`,
        opened.id,
        {
          kind: "composer",
          payload: { ...address, rowVersion: opened.rowVersion, content: "Text from another tab" }
        },
        1
      )
      let current = written.draft!
      if (kind === "lost displacement acknowledgement" && displacement.save.kind === "composer") {
        const displaced = yield* api.SaveComposer(displacement.save.payload)
        assert.strictEqual(displaced.draft!.displaced?.content, written.draft!.content)
        current = displaced.draft!
      }
      const clear = makeCopy(
        owner,
        `composer:${chat.id}`,
        opened.id,
        {
          kind: "composer",
          payload: { ...address, rowVersion: current.rowVersion, content: "" }
        },
        1
      )
      assert.strictEqual(clear.save.kind, "composer")
      if (clear.save.kind !== "composer") return
      // The closing save reached the server, but the page closed before it could
      // remove its durable browser copy. Reopening must replay that exact receipt.
      const cleared = yield* api.SaveComposer(clear.save.payload)
      assert.isAbove(cleared.draft!.clearedVersion!, current.rowVersion)
      const copy =
        kind === "lost clear acknowledgement"
          ? clear
          : kind === "lost displacement acknowledgement"
            ? displacement
            : makeCopy(
                owner,
                `composer:${chat.id}`,
                opened.id,
                {
                  kind: "composer",
                  payload: {
                    ...address,
                    rowVersion: written.draft!.rowVersion,
                    content: "Offline text before deletion"
                  }
                },
                1
              )
      copies.set(copy.key, copy)
      const replayed: Array<unknown> = []
      const session = {
        id: chat.id,
        call: async (
          fn: (
            client: (tag: "OpenComposer" | "SaveComposer", p: never) => Effect.Effect<unknown, unknown>
          ) => Effect.Effect<unknown, unknown>
        ) => ({
          ok: true,
          value: await Effect.runPromise(
            fn((tag, p) => {
              if (tag === "SaveComposer") replayed.push(p)
              return api[tag](p)
            })
          )
        })
      }
      const store = new ComposerDraft(session as unknown as ChatSession, owner, {
        setTimer: () => 0,
        clearTimer: () => {},
        now: () => 100000,
        keepalive: async () => false
      })
      store.setFork(null, false)
      yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(store.snapshot().ready)))
      assert.deepStrictEqual(replayed, [copy.save.payload])
      assert.strictEqual(copies.size, 0)
      assert.strictEqual(store.snapshot().text, "")
      assert.isNull(store.snapshot().conflict)
      const server = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      assert.strictEqual(server.content, "")
      assert.strictEqual(server.rowVersion, cleared.draft!.rowVersion)
      const recovered = yield* api.ListRecoveredTexts({ limit: 100, before: null })
      assert.strictEqual(
        recovered.some((entry) => entry.content === copy.content),
        kind === "stale text"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
