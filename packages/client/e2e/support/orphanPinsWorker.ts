// Synthetic damage for the database check (databaseCheck.spec.ts): pins of chats that aren't
// there, written with foreign keys off as an outside tool would. SQLite stays in this worker.
import { DatabaseSync } from "node:sqlite"
import { workerData } from "node:worker_threads"

const { dbPath, chats } = workerData as { dbPath: string; chats: ReadonlyArray<string> }
const db = new DatabaseSync(dbPath)
try {
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 30000")
  const { id } = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string }
  const pin = db.prepare("INSERT INTO chat_pins (user_id, chat_id) VALUES (?, ?)")
  for (const chat of chats) pin.run(id, chat)
} finally {
  db.close()
}
