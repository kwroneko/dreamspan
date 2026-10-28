import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { HistoryCursor } from "@rp/shared/historyApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const config = testConfig()
it.effect(
  "scans 100,000 synthetic messages in bounded reader windows",
  () =>
    Effect.gen(function* () {
      const api = yield* client()
      const userId = (yield* api.Whoami()).id
      const writer = yield* Writer
      const reader = yield* Reader
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Scale",
        participants: [],
        greeting: null
      })
      const chatId = chat.id,
        forkId = chat.currentForkId!
      yield* fixtureSql(config.dataDir, [
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<99999)
      INSERT INTO versions(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
      SELECT ?||'-v'||x,?||'-s'||x,0,'complete',NULL,'human','Aria in the garden.','verbatim','user_written',1,1 FROM n`,
          params: [chatId, chatId]
        },
        {
          sql: `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<99999)
      INSERT INTO slots(id,chat_id,lane_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
      SELECT ?||'-s'||x,?,(SELECT id FROM lanes WHERE chat_id=? LIMIT 1),CASE WHEN x=0 THEN NULL ELSE ?||'-s'||(x-1) END,x,?||'-v'||x,1,? FROM n`,
          params: [chatId, chatId, chatId, chatId, chatId, forkId]
        },
        { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [chatId + "-s99999", forkId] }
      ])
      let cursor: typeof HistoryCursor.Type | undefined
      let count = 0,
        pages = 0
      do {
        const page = yield* reader.PreviewHistory({
          userId,
          chatId,
          forkId,
          search: {
            pairs: [{ find: "Ar(ia)", replace: "$1" }],
            regex: true,
            matchCase: true,
            wholeWord: false,
            preserveCase: false,
            messages: true,
            swipes: false,
            summaries: false
          },
          ...(cursor ? { cursor } : {})
        })
        assert.isAtMost(page.hits.length, 100)
        assert.isTrue(page.hits.every((h) => h.after === "ia in the garden."))
        count += page.hits.length
        pages++
        cursor = page.next ?? undefined
      } while (cursor)
      assert.strictEqual(count, 100000)
      assert.strictEqual(pages, 1000)
    }).pipe(Effect.provide(serverLayer(config))),
  120000
)
