import { parentPort, workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { previousHistoryStart } from "../../src/db/historyStart.ts"

export interface HistoryWorkSample {
  candidates: number
  ancestryReads: number
  elapsedMs: number
  start: { slot_id: string | null; depth: number }
  plan: Array<string>
}

const { file, chatId, userId, workload } = workerData as {
  file: string
  chatId: string
  userId: string
  workload: "long" | "siblings" | "swipes"
}
const length = workload === "long" ? 100000 : 10000
const db = new DatabaseSync(file)
try {
  {
    db.exec("PRAGMA foreign_keys = ON; BEGIN")
    const version =
      db.prepare(`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
      VALUES (?, ?, 0, ?, 'model', ?, 'verbatim', 'generated', 1, 1)`)
    const slot = db.prepare(
      `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at) VALUES (?, ?, ?, ?, ?, 1)`
    )
    for (let i = 0; i <= length; i++) {
      version.run(
        `perf-v-${i}`,
        `perf-s-${i}`,
        i === length ? "generating" : "complete",
        i === length ? "" : "x".repeat(100)
      )
      slot.run(`perf-s-${i}`, chatId, i ? `perf-s-${i - 1}` : null, i, `perf-v-${i}`)
    }
    db.prepare("UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?").run(`perf-s-${length}`, chatId)
    db.exec("COMMIT")
  }
  if (workload !== "long") {
    db.exec("BEGIN")
    const slot = db.prepare(`INSERT INTO slots
      (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
      VALUES (?, ?, ?, ?, ?, 1)`)
    const version = db.prepare(`INSERT INTO version_records
      (id, slot_id, ordinal, status, writer, content, macro_mode, origin, rollout_id, created_at, updated_at)
      VALUES (?, ?, ?, 'complete', 'model', 'Synthetic reply', 'verbatim', 'generated', ?, 1, 1)`)
    const rollout = db.prepare(`INSERT INTO rollouts
      (id, chat_id, kind, status, slot_id, leaf_slot_id, role, request_class, created_at, updated_at,
       history_start_slot_id, history_start_depth, history_depth)
      VALUES (?, ?, 'generation', 'completed', ?, ?, 'assistant', 'interactive', ?, 1, 'perf-s-0', 0, ?)`)
    rollout.run("perf-root", chatId, "perf-s-1", "perf-s-0", 0, 1)
    db.prepare("UPDATE versions SET rollout_id = 'perf-root' WHERE id = 'perf-v-1'").run()
    for (let i = 1; i <= (workload === "siblings" ? 500 : 1); i++) {
      version.run(`perf-bv-${i}`, `perf-b-${i}`, 0, null)
      slot.run(`perf-b-${i}`, chatId, i === 1 ? "perf-s-1" : `perf-b-${i - 1}`, i + 1, `perf-bv-${i}`)
    }
    for (let i = 1; i <= 500; i++) {
      const slotId = workload === "siblings" ? `perf-b-${i}` : "perf-b-1"
      const parent = workload === "siblings" && i > 1 ? `perf-b-${i - 1}` : "perf-s-1"
      rollout.run(`perf-off-${i}`, chatId, slotId, parent, i, null)
      if (workload === "swipes") version.run(`perf-swipe-${i}`, slotId, i, `perf-off-${i}`)
      else db.prepare("UPDATE versions SET rollout_id = ? WHERE id = ?").run(`perf-off-${i}`, `perf-bv-${i}`)
    }
    db.exec("COMMIT")
  }
  const [text, parameters] = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return previousHistoryStart(sql, userId, chatId, `perf-s-${length}`).compile()
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readonly: true })))
  )
  const bindings = parameters as Array<string | number | null>
  if (workload === "long") {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...bindings) as Array<{ detail: string }>
    parentPort!.postMessage(plan.map((row) => row.detail))
  } else {
    let ancestryReads = 0
    db.function("history_perf_parent", (value) => {
      ancestryReads++
      return value
    })
    // A flattenable view preserves primary-key searches while counting the actual
    // ancestry edges read by the production SQL, independently of host load.
    db.exec(`CREATE TEMP VIEW slots AS SELECT id, chat_id, depth,
      history_perf_parent(parent_slot_id) AS parent_slot_id FROM main.slots`)
    const samples: Array<HistoryWorkSample> = []
    for (const candidates of [0, 100, 500]) {
      db.prepare(
        `UPDATE rollouts SET history_depth = CASE WHEN created_at <= ?
        THEN (SELECT depth FROM main.slots WHERE id = rollouts.slot_id) ELSE NULL END
        WHERE id <> 'perf-root'`
      ).run(candidates)
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...bindings) as Array<{ detail: string }>
      ancestryReads = 0
      const at = performance.now()
      const rows = db.prepare(text).all(...bindings) as Array<{ slot_id: string | null; depth: number }>
      const elapsedMs = performance.now() - at
      if (!rows[0]) throw new Error("No inherited start found on the synthetic branch")
      samples.push({
        candidates,
        ancestryReads,
        elapsedMs,
        start: { slot_id: rows[0].slot_id, depth: rows[0].depth },
        plan: plan.map((row) => row.detail)
      })
    }
    parentPort!.postMessage(samples)
  }
} finally {
  db.close()
}
