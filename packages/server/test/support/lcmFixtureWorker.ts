import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"

const { dbPath, statements, readOnly } = workerData as {
  dbPath: string
  readOnly: boolean
  statements: ReadonlyArray<{ sql: string; params?: ReadonlyArray<string | number | null> }>
}
const db = new DatabaseSync(dbPath, { readOnly })
db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; ${readOnly ? "BEGIN" : "BEGIN IMMEDIATE"}`)
try {
  const results = statements.map(({ sql, params = [] }) => db.prepare(sql).all(...params))
  db.exec("COMMIT")
  parentPort!.postMessage({ results })
} catch (error) {
  db.exec("ROLLBACK")
  parentPort!.postMessage({ error: String(error) })
} finally {
  db.close()
}
