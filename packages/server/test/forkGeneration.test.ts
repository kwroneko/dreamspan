// A generation reads its context in the fork it was started in, not in the chat's current
// fork when it gets to it. A swipe in one fork waits for summaries first
// (Summarizer.beforeReply); the user chatting meanwhile in another fork whose path holds the
// message must not give the swipe that fork's choices (here its greeting).
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Deferred, Effect, Layer } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

describe("generation in a fork", () => {
  it.live("a swipe is written from the choices of the fork it was made in", () => {
    const config = testConfig()
    let gate: Deferred.Deferred<void> | null = null
    // The forks summaries are planned in, before and after each reply.
    const planned: Array<{ readonly when: "before" | "after"; readonly forkId: ForkId | undefined }> = []
    const summaries = Layer.succeed(Summarizer)({
      afterReply: (position) => Effect.sync(() => void planned.push({ when: "after", forkId: position.forkId })),
      beforeReply: (position) =>
        Effect.suspend(() => {
          planned.push({ when: "before", forkId: position.forkId })
          return gate === null ? Effect.succeed(false) : Deferred.await(gate).pipe(Effect.as(false))
        }),
      runJob: () => Effect.void,
      planNow: () => Effect.succeed([])
    })
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, completionChunks(["A swipe."], { prompt_tokens: 10, completion_tokens: 2 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const { version, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const userId = (yield* api.Whoami()).id as UserId
      const main = chat.currentForkId! as ForkId
      const greeting = chat.activeLeafSlotId! as SlotId
      const reply = version.slotId as SlotId
      const shown = yield* reader.GetSlot({ userId, slotId: greeting, forkId: main })
      const alt = yield* writer.AddVersion({
        userId,
        slotId: greeting,
        version: new NewVersion({
          speakerEntityId: shown.entry.version.speakerEntityId as EntityId,
          writer: "model",
          content: "ALT GREETING from the other fork.",
          status: "complete",
          macroMode: "verbatim",
          origin: "greeting"
        }),
        select: false,
        commitDraft: null
      })
      // Fork B at the reply, which shows the other greeting.
      const b = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: reply })).fork.id
      yield* writer.SelectVersion({
        userId,
        slotId: greeting,
        versionId: alt.id as VersionId,
        forkId: b,
        expectedVersionId: shown.entry.version.id
      })

      // A swipe of the reply in the main fork, waiting for summaries.
      gate = yield* Deferred.make<void>()
      const before = mock.requests().length
      const atReply = yield* reader.GetSlot({ userId, slotId: reply, forkId: main })
      const swipe = yield* api.Regenerate({ slotId: reply, forkId: main, expectedRowVersion: atReply.entry.rowVersion })
      // Meanwhile the user chats in fork B.
      yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: b,
        parentSlotId: reply,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "Over in B.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        commitDraft: null
      })
      const mark = planned.length
      Deferred.doneUnsafe(gate, Effect.void)
      gate = null
      yield* eventually(() => mock.requests().length > before)
      const body = JSON.stringify(mock.requests().at(-1)!.body)
      assert.notInclude(body, "ALT GREETING", "the main fork's swipe uses the main fork's greeting")
      assert.include(body, "Late again")
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      try {
        const rollout = db
          .prepare("SELECT r.fork_id FROM versions v JOIN rollouts r ON r.id = v.rollout_id WHERE v.id = ?")
          .get(swipe.version.id) as { fork_id: string } | undefined
        assert.strictEqual(rollout?.fork_id, main)
      } finally {
        db.close()
      }
      // Its summaries are planned in the main fork too, not in B, current by now.
      yield* eventually(() => planned.slice(mark).some((p) => p.when === "after"))
      assert.deepStrictEqual(planned.slice(mark - 1), [
        { when: "before", forkId: main },
        { when: "after", forkId: main }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, undefined, summaries)))
  })
})
