// Count real slot probes in the existing newer-page operation, entirely in a worker.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { join } from "node:path"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { SqlClient } from "effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { walkTowards } from "../../src/db/reads.ts"

const { dir } = workerData as { dir: string }
const prepare = DatabaseSync.prototype.prepare
let visits = 0
const counted = new WeakSet<DatabaseSync>()
const results: Array<{ length: number; visits: number; last: string | undefined }> = []
for (const length of [1000, 10_000]) {
  const file = join(dir, `path-${length}.db`)
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE slots(id TEXT PRIMARY KEY,chat_id TEXT,parent_slot_id TEXT,depth INTEGER,chain_id TEXT,inserted INTEGER);
    CREATE INDEX slots_parent ON slots(parent_slot_id);
    CREATE UNIQUE INDEX slots_chain ON slots(chain_id,depth); BEGIN`)
  const insert = prepare.call(db, "INSERT INTO slots VALUES(?,'chat',?,?,?,0)")
  let chain = "p-0"
  for (let depth = 0; depth < length; depth++) {
    const parent = depth ? `p-${depth - 1}` : null
    // The selected path is the second child at twenty early branch points.
    // Both lengths have the same branches; only the distance to the leaf changes.
    if (depth <= 200 && depth % 10 === 1) {
      insert.run(`side-${depth}`, parent, depth, chain)
      chain = `p-${depth}`
    }
    insert.run(`p-${depth}`, parent, depth, chain)
  }
  db.exec("COMMIT")
  db.close()
  DatabaseSync.prototype.prepare = function (query) {
    if (!counted.has(this)) {
      counted.add(this)
      this.function("visit", { deterministic: false, varargs: true }, () => {
        visits++
        return 1
      })
      this.exec("CREATE TEMP VIEW slots AS SELECT * FROM main.slots WHERE visit(rowid)")
    }
    return prepare.call(this, query)
  }
  visits = 0
  const last = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* walkTowards(
        sql,
        { id: `p-${length - 1}` as SlotId, depth: length - 1 },
        { id: "p-0" as SlotId, depth: 0 },
        60
      )
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readonly: true })), Effect.scoped)
  )
  results.push({ length, visits, last: last?.id })
  DatabaseSync.prototype.prepare = prepare
}
parentPort!.postMessage(results)
