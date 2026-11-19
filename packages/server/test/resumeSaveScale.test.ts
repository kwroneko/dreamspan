// The periodic save under the owner's data shape, with three replies stalled at once.
// Synthetic rows only; the generator never contacts a provider. Slow by its Scale suffix.
import { assert, it } from "@effect/vitest"
import type { Chat, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect, Layer, Option, Stream } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live(
  "three stalled replies save at 5,000 messages, 300 forks and 50 versions per message; late saves cannot revive them",
  () => {
    const config = testConfig()
    const content = "The lighthouse 🌊 ledger. ".repeat(400)
    const generator = Layer.succeed(Generator)(
      Option.some({ generate: () => Stream.concat(Stream.make(content), Stream.fromEffect(Effect.never)) })
    )
    return Effect.gen(function* () {
      const api = yield* client()
      const secondTab = yield* client()
      const user = yield* api.Whoami()
      const writer = yield* Writer
      const reader = yield* Reader
      const chats: Array<{ readonly chat: Chat; readonly leaf: SlotId }> = []
      for (let i = 0; i < 3; i++) {
        const chat = yield* api.CreateChat({ title: `Streaming scale ${i}` })
        const prefix = `save-${i}-`
        yield* fixtureSql(config.dataDir, [
          {
            sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<4999)
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
          SELECT '${prefix}v-'||n,'${prefix}s-'||n,0,'complete','model','Synthetic history '||n,'verbatim','generated',1,1,? FROM ns`,
            params: [chat.currentForkId]
          },
          {
            sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<4999)
          INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at)
          SELECT '${prefix}s-'||n,?,CASE WHEN n=0 THEN NULL ELSE '${prefix}s-'||(n-1) END,n,'${prefix}v-'||n,1 FROM ns`,
            params: [chat.id]
          },
          { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${prefix}s-4999`, chat.currentForkId] },
          { sql: "UPDATE chats SET active_leaf_slot_id=? WHERE id=?", params: [`${prefix}s-4999`, chat.id] },
          {
            sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<49),
          messages(depth) AS (VALUES(0) UNION ALL SELECT depth+1 FROM messages WHERE depth<4999)
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
          SELECT '${prefix}alt-'||depth||'-'||n,'${prefix}s-'||depth,n,'complete','model','Alternate '||depth||' version '||n,'verbatim','generated',1,1,? FROM messages CROSS JOIN ns`,
            params: [chat.currentForkId]
          },
          {
            sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<299)
          INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,tip_slot_id,created_at)
          SELECT '${prefix}f-'||n,?,?,0,'${prefix}s-4999',1 FROM ns`,
            params: [chat.id, chat.currentForkId]
          }
        ])
        chats.push({ chat, leaf: `${prefix}s-4999` as SlotId })
      }
      const started = Date.now()
      const entries = yield* Effect.forEach(
        chats,
        ({ chat, leaf }) => posted(api.Generate({ chatId: chat.id, parentSlotId: leaf, branch: false })),
        { concurrency: 3 }
      )
      const deadline = Date.now() + 20_000
      while (true) {
        const versions = yield* Effect.forEach(
          entries,
          ({ entry }) => reader.GetVersion({ userId: user.id, versionId: entry.version.id }),
          { concurrency: 3 }
        )
        if (versions.every((v) => v.content === content)) break
        if (Date.now() > deadline) return yield* Effect.die("stalled replies were not saved")
        yield* Effect.sleep(100)
      }
      process.stdout.write(
        `Three periodic saves at scale: ${Date.now() - started} ms including the 2 s save interval\n`
      )
      // A second tab stopping the same reply concurrently gets the same terminal version.
      const id = entries[0]!.entry.version.id
      const stopped = yield* Effect.all(
        [api.StopGeneration({ versionId: id }), secondTab.StopGeneration({ versionId: id })],
        { concurrency: 2 }
      )
      assert.isTrue(stopped.every((v) => v.status === "stopped" && v.content === content))
      yield* api.DeleteChat({ chatId: chats[1]!.chat.id })
      yield* api.StopGeneration({ versionId: entries[2]!.entry.version.id })
      const late = yield* writer
        .SaveGeneration({ userId: user.id, versionId: id, content: "Stale text", status: "generating", error: null })
        .pipe(Effect.result)
      assert.strictEqual(late._tag, "Failure")
      yield* Effect.sleep(2500)
      assert.strictEqual((yield* reader.GetVersion({ userId: user.id, versionId: id })).content, content)
      assert.strictEqual((yield* reader.GetVersion({ userId: user.id, versionId: id })).status, "stopped")
      assert.isFalse(
        (yield* api.ListChats({ limit: 100, before: null })).some((c) => c.id === chats[1]!.chat.id),
        "a late tick never restores a deleted chat"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, generator)))
  },
  { timeout: 180_000, tags: ["slow"] }
)
