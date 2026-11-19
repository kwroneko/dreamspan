// Synthetic ledger rows: pagination must retain work started in the same millisecond.
import { assert, it } from "@effect/vitest"
import type { ActivityPage } from "@dreamspan/shared/agent.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("Activity pages retain tied start times and purposes without losing or repeating rows", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const chat = yield* api.CreateChat({ title: "Synthetic activity" })
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Synthetic",
        baseUrl: "http://127.0.0.1:1/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const rollout = "aa-request-115"
    const statements: Array<{ sql: string; params: Array<string | number | null> }> = [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES(?,?,'decision','completed','judge','background',1000,2000)",
        params: [rollout, chat.id]
      }
    ]
    // More than a page, including two purposes on the same rollout and retries in one group.
    for (let i = 0; i < 54; i++) {
      statements.push({
        sql: "INSERT INTO llm_requests(id,owner_user_id,connection_id,chat_id,rollout_id,purpose,api,provider,model_key,status,started_at,ended_at,input_uncached,cache_read,cache_write,output,usage_source,cost,cost_currency,cost_formula) VALUES(?,?,?,?,?,?,'openai','synthetic','synthetic','complete',1000,2000,10,2,0,3,'reported',0.25,'USD','reported')",
        params: [
          i < 3 ? `zz-request-${i}` : `aa-request-${i}`,
          user.id,
          connection.id,
          chat.id,
          i < 3 ? rollout : null,
          i === 0 ? "decision" : "idle_job"
        ]
      })
    }
    yield* fixtureSql(config.dataDir, statements)
    const rows: Array<ActivityPage["rows"][number]> = []
    let before: ActivityPage["before"] = null
    do {
      const page: ActivityPage = yield* api.ListActivity({ chatId: chat.id, ...(before === null ? {} : { before }) })
      rows.push(...page.rows)
      before = page.before
      assert.isAtMost(rows.length, 53, "pagination must terminate without duplicates")
    } while (before !== null)
    assert.strictEqual(rows.length, 53)
    assert.strictEqual(new Set(rows.map((r) => `${r.id}:${r.kind}`)).size, 53)
    assert.deepInclude(
      rows.find((r) => r.id === rollout && r.kind === "idle_job"),
      {
        requests: 2,
        input: 20,
        cacheRead: 4,
        cacheWrite: 0,
        output: 6,
        cost: { amount: 0.5, currency: "USD" }
      }
    )
    assert.strictEqual(rows.find((r) => r.id === rollout && r.kind === "decision")?.requests, 1)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
