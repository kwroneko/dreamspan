import { parentPort, workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { previousHistoryStart } from "../../src/db/historyStart.ts"

const { file, chatId, userId, seed } = workerData as { file: string; chatId: string; userId: string; seed: boolean }
const db = new DatabaseSync(file)
try {
  if (seed) {
    const lane = (db.prepare("SELECT id FROM lanes WHERE chat_id = ?").get(chatId) as { id: string }).id
    db.exec("PRAGMA foreign_keys = ON; BEGIN")
    const version =
      db.prepare(`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
      VALUES (?, ?, 0, ?, 'model', ?, 'verbatim', 'generated', 1, 1)`)
    const slot = db.prepare(
      `INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    for (let i = 0; i <= 100000; i++) {
      version.run(
        `perf-v-${i}`,
        `perf-s-${i}`,
        i === 100000 ? "generating" : "complete",
        i === 100000 ? "" : "x".repeat(100)
      )
      slot.run(`perf-s-${i}`, chatId, lane, i ? `perf-s-${i - 1}` : null, i, `perf-v-${i}`)
    }
    db.prepare("UPDATE chats SET active_leaf_slot_id = 'perf-s-100000' WHERE id = ?").run(chatId)
    db.exec("COMMIT")
  }
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [text, parameters] = previousHistoryStart(sql, userId, chatId, "perf-s-100000").compile()
      return db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...(parameters as Array<string | number | null>)) as Array<{
        detail: string
      }>
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readonly: true })))
  )
  parentPort!.postMessage(plan.map((row) => row.detail))
} finally {
  db.close()
}
