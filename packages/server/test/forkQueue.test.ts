// The send queue in forks: two forks can wait on the same reply still being written (a fork
// made at that reply while it generates). When it ends, each fork's message posts in that
// fork with a reply of its own, never in the fork that queued first.
import { assert, describe, it } from "@effect/vitest"
import { type ForkId, NewVersion } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

const version = (content: string, writer: "human" | "model", status: "complete" | "generating" = "complete") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status,
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

describe("the queue in forks", () => {
  it.live("a message queued in a fork posts in that fork, whoever queued first", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id as UserId
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Queue",
        participants: [],
        greeting: null
      })
      const main = chat.currentForkId! as ForkId
      const m0 = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        version: version("m0", "human"),
        commitDraft: null
      })
      const reply = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: m0.slotId,
        branch: false,
        version: version("", "model", "generating"),
        commitDraft: null
      })
      // A fork made at the reply while it's being written.
      const b = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: reply.slotId })).fork
        .id
      const queue = (forkId: ForkId, content: string) =>
        writer.SendOrQueue({
          userId,
          chatId: chat.id,
          forkId,
          parentSlotId: reply.slotId,
          branch: false,
          kind: "message",
          content,
          speakerEntityId: null,
          replySpeakerEntityId: null,
          direction: null,
          commitDraft: null
        })
      assert.strictEqual((yield* queue(main, "from main"))._tag, "Queued")
      assert.strictEqual((yield* queue(b, "from b"))._tag, "Queued")
      const first = yield* writer.FinishGeneration({
        userId,
        versionId: reply.version.id,
        content: "The reply.",
        status: "complete",
        error: null
      })
      // Each fork's message posted with a reply of its own, being written.
      assert.lengthOf(first.posted, 4)
      assert.strictEqual(first.more?.length, 1)
      yield* writer.FinishGeneration({
        userId,
        versionId: first.next!.versionId,
        content: "Main's second reply.",
        status: "complete",
        error: null
      })
      const texts = (forkId: ForkId) =>
        Effect.map(reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 50 }), (p) =>
          p.entries.map((e) => e.version.content)
        )
      const inMain = yield* texts(main)
      assert.include(inMain, "from main")
      assert.notInclude(inMain, "from b", "b's message never posts in main")
      const inB = yield* texts(b)
      assert.deepStrictEqual(inB.slice(0, 3), ["m0", "The reply.", "from b"])
      assert.notInclude(inB, "from main")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
