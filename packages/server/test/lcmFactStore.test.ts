import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { factStore } from "../src/db/lcmFactStore.ts"
import { baseline, lcmStampTriggers } from "../src/db/baseline.ts"

// Only the fact store's three metadata reads; no SQLite runs on the test thread.
const connection = () => {
  const state = { schema: 1, stamp: 0, top: 1, triggers: lcmStampTriggers.length }
  const sql = ((parts: TemplateStringsArray) => {
    const query = parts.join("?")
    return Effect.succeed(
      query.includes("schema_version")
        ? [{ schema_version: state.schema }]
        : query.includes("sqlite_schema")
          ? [{ count: state.triggers }]
          : [{ stamp: state.stamp, top: state.top }]
    )
  }) as unknown as SqlClient.SqlClient
  const at = (key: string) => Effect.runSync(factStore<string>(sql, "chat", key))
  return { state, at }
}

it("bounds retained facts across hundreds of branch keys and promotes recently used entries", () => {
  const { at } = connection()
  for (let n = 0; n < 400; n++) at(`user/chat-${n}/fork`)!.save(`value-${n}`, 1)
  assert.isUndefined(at("user/chat-391/fork")!.hit)
  assert.strictEqual(at("user/chat-392/fork")!.hit, "value-392")
  at("user/chat-392/fork")!.save("value-392", 1)
  at("next")!.save("next", 1)
  assert.strictEqual(at("user/chat-392/fork")!.hit, "value-392")
  assert.isUndefined(at("user/chat-393/fork")!.hit)
})

it("caps the aggregate weight, refuses oversized entries, and fences stamps and restarts", () => {
  const { at, state } = connection()
  at("a")!.save("a", 32_000_000)
  at("b")!.save("b", 32_000_000)
  at("c")!.save("c", 1)
  assert.isUndefined(at("a")!.hit)
  assert.strictEqual(at("b")!.hit, "b")
  at("b")!.save("oversized", 64_000_001)
  assert.isUndefined(at("b")!.hit)
  state.stamp++
  assert.isUndefined(at("c")!.hit)
  at("c")!.save("new", 1)
  state.schema++
  assert.isUndefined(at("c")!.hit)
  at("c")!.save("new", 1)
  assert.isUndefined(connection().at("c")!.hit)
  state.triggers--
  state.schema++
  assert.isUndefined(at("c"))
})

it("finds the chat watermark and new rows without scanning its unrelated summaries", async () => {
  // Exercise SQLite's access plan in a worker. The existing indexes suffice for selection by
  // level, but not for an incremental rowid watermark: it must stop at the first match.
  const worker = new Worker(
    `
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE summaries (id TEXT PRIMARY KEY, chat_id TEXT, level INTEGER, status TEXT, first_slot_id TEXT, last_slot_id TEXT, selected_revision_id TEXT, rollout_id TEXT, sealed INTEGER)");
    for (const statement of workerData) db.exec(statement);
    const code = db.prepare("EXPLAIN SELECT max(rowid) FROM summaries WHERE chat_id=?").all("synthetic");
    const aggregate = code.findIndex(row => row.opcode === "AggStep");
    const delta = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM summaries WHERE chat_id=? AND rowid>? AND sealed=1").all("synthetic", 1);
    db.close();
    parentPort.postMessage({ stopAfterFirst: aggregate >= 0 && code[aggregate + 1]?.opcode === "Goto", deltaBound: delta.some(row => row.detail.includes("rowid>?")) });
  `,
    { eval: true, workerData: baseline.filter((s) => s.startsWith("CREATE INDEX summaries_")) }
  )
  const result = await new Promise<{ stopAfterFirst: boolean; deltaBound: boolean }>((resolve, reject) => {
    let answer: { stopAfterFirst: boolean; deltaBound: boolean } | undefined
    worker.once("message", (value) => {
      answer = value
    })
    worker.once("error", reject)
    worker.once("exit", (code) =>
      code === 0 && answer ? resolve(answer) : reject(new Error(`index worker exited ${code}`))
    )
  })
  assert.isTrue(result.stopAfterFirst, "max(rowid) must stop after its first matching index entry")
  assert.isTrue(result.deltaBound, "the rowid delta must be an index bound, not a filter on the whole chat")
})
