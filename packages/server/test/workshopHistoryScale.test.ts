// The workshop's history tools at the owner's data shape (spec/WORKSHOP-CONTEXT.md §3): 3,000
// messages, 300 forks and 20 swipes on the newest. Each read stays bounded in what it returns
// and in how long it takes, and never reaches past the message being written.
import { assert, it } from "@effect/vitest"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { historyTools } from "../src/agent/tools/history.ts"
import { runTools } from "../src/agent/tools/runs.ts"
import { budgetResult, type ToolContext } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const MESSAGES = 3000
const LONG = "harbor ledger ".repeat(150)

it.live("workshop history reads stay bounded with 3,000 messages, 300 forks and 20 swipes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer,
      reader = yield* Reader
    const chat = yield* api.CreateWorkshop({})
    const last = MESSAGES - 1
    yield* fixtureSql(config.dataDir, [
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<${last})
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id)
          SELECT 'ws-v-'||n,'ws-s-'||n,0,'complete',CASE WHEN n%2=0 THEN 'human' ELSE 'model' END,
            'Step '||n||' '||?,'verbatim','generated',1,1,? FROM ns`,
        params: [LONG, chat.currentForkId]
      },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ns WHERE n<${last})
          INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at)
          SELECT 'ws-s-'||n,?,CASE WHEN n=0 THEN ? ELSE 'ws-s-'||(n-1) END,n+1,'ws-v-'||n,1 FROM ns`,
        params: [chat.id, chat.activeLeafSlotId]
      },
      { sql: `UPDATE forks SET tip_slot_id='ws-s-${last}' WHERE id=?`, params: [chat.currentForkId] },
      { sql: `UPDATE chats SET active_leaf_slot_id='ws-s-${last}' WHERE id=?`, params: [chat.id] },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<20)
          INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id)
          SELECT 'ws-alt-'||n,'ws-s-${last}',n,'complete','model','Unseen swipe '||n,'verbatim','generated',1,1,? FROM ns`,
        params: [chat.currentForkId]
      },
      {
        sql: `WITH RECURSIVE ns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ns WHERE n<299)
          INSERT INTO forks(id,chat_id,parent_fork_id,branched_at,tip_slot_id,created_at)
          SELECT 'ws-f-'||n,?,?,0,'ws-s-${last}',1 FROM ns`,
        params: [chat.id, chat.currentForkId]
      }
    ])
    // Writing the reply to message 1,500: nothing after it is visible.
    const middle = 1499
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: `ws-s-${middle + 1}` as SlotId,
      versionId: `ws-v-${middle + 1}` as VersionId,
      leafSlotId: `ws-s-${middle}` as SlotId,
      viewers: null,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader,
      writer
    }
    const tool = (id: string) => [...historyTools, ...runTools].find((t) => t.id === id)!
    const timed = (id: string, args: unknown) =>
      Effect.gen(function* () {
        const began = Date.now()
        const out = yield* tool(id).execute(context, args as never)
        return { text: budgetResult(out.text), ms: Date.now() - began }
      })
    const search = yield* timed("search_chat", { query: "harbor ledger", limit: 20 })
    const read = yield* timed("read_messages", { from: 1, count: 20 })
    const late = yield* timed("read_messages", { from: middle + 10, count: 20 })
    const run = yield* timed("read_run", { message: 3 })
    const after = yield* timed("read_run", { message: middle + 50 })
    // Message n is depth n-1: the greeting is message 1, the fixture's step k is message k+2.
    assert.lengthOf(search.text.split("\n"), 20)
    assert.include(search.text, `Message ${middle + 2}, `)
    assert.notInclude(search.text, `Message ${middle + 3},`)
    assert.isAtMost(read.text.length, 16_000 + 200)
    assert.include(late.text, `The earlier messages end at message ${middle + 2}.`)
    assert.include(run.text, "written without tool calls")
    assert.include(after.text, "isn't one of the earlier messages")
    for (const out of [search, read, late, run, after]) assert.notInclude(out.text, "Unseen swipe")
    const total = [search, read, late, run, after].reduce((sum, out) => sum + out.ms, 0)
    process.stdout.write(
      `Workshop history scale: search ${search.ms} ms, read ${read.ms} ms, read past the end ${late.ms} ms, read_run ${run.ms} ms, read_run past the end ${after.ms} ms\n`
    )
    assert.isBelow(total, 10_000)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
