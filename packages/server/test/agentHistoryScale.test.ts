import { assert, it } from "@effect/vitest"
import type { SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { historyTools } from "../src/agent/tools/history.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("history reads stay on the selected path with 5,000 messages, 300 forks and 50 swipes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer,
      reader = yield* Reader
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic scale",
      participants: [],
      greeting: null
    })
    yield* fixtureSql(config.dataDir, [
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<4999)
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id)
          SELECT 'scale-v-'||n,'scale-s-'||n,0,'complete','model','Lighthouse original '||n,'verbatim','generated',1,1 , '${chat.currentForkId!}' FROM ns`
      },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<4999)
          INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at)
          SELECT 'scale-s-'||n,?,CASE WHEN n=0 THEN NULL ELSE 'scale-s-'||(n-1) END,n,'scale-v-'||n,1 FROM ns`,
        params: [chat.id]
      },
      { sql: "UPDATE forks SET tip_slot_id='scale-s-4999' WHERE id=?", params: [chat.currentForkId] },
      { sql: "UPDATE chats SET active_leaf_slot_id='scale-s-4999' WHERE id=?", params: [chat.id] },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<50)
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id)
          SELECT 'scale-alt-'||n,'scale-s-4999',n,'complete','model','Lighthouse alternate '||n,'verbatim','generated',1,1 , '${chat.currentForkId!}' FROM ns`
      },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<299)
          INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,tip_slot_id,created_at)
          SELECT 'scale-f-'||n,?,?,0,'scale-s-4999',1 FROM ns`,
        params: [chat.id, chat.currentForkId]
      },
      {
        sql: `INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
          VALUES('scale-select',?,'scale-f-299',1,'select','scale-s-4999','scale-s-4999',4999,'scale-alt-50')`,
        params: [chat.id]
      }
    ])
    let windows = 0
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: "scale-s-4999" as SlotId,
      versionId: "scale-v-4999" as VersionId,
      leafSlotId: "scale-s-4999" as SlotId,
      viewers: null,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader: {
        ...reader,
        // Exercise the paged fallback used by forks with inserted messages, rather than FTS.
        SearchChat: (() => Effect.succeed(null)) as Reader["Service"]["SearchChat"],
        ReadPath: (input) => {
          windows++
          return reader.ReadPath(input)
        }
      },
      writer
    }
    const tool = historyTools.find((t) => t.id === "search_chat")!
    const began = Date.now()
    const original = yield* tool.execute(context, { query: "lighthouse", limit: 1 } as never)
    assert.strictEqual(original.text, "Message 5000, Narrator: Lighthouse original 4999")
    assert.strictEqual(windows, 10)
    const excluded = yield* tool.execute(context, { query: "alternate" } as never)
    assert.include(excluded.text, "No earlier messages")
    assert.strictEqual(windows, 10, "subsequent lookups reuse the rollout's path")
    const other = yield* tool.execute(
      { ...context, forkId: "scale-f-299" as ToolContext["forkId"], cache: new Map() },
      { query: "alternate", limit: 1 } as never
    )
    assert.strictEqual(other.text, "Message 5000, Narrator: Lighthouse alternate 50")
    process.stdout.write(`Agent history scale: ${Date.now() - began} ms for two paths and three searches\n`)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
