// Synthetic browser scale setup only. SQLite stays in this worker; the browser measures
// the normal reader RPC and virtualized rows, with two changes at every message.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { rebuildForkLabels } from "../../../server/src/db/forkLabels.ts"

const { dbPath, chatId, forkId, count } = workerData as {
  dbPath: string
  chatId: string
  forkId: string
  count: number
}
const db = new DatabaseSync(dbPath)
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; BEGIN IMMEDIATE; INSERT INTO fork_label_pause VALUES (1)")
  const version = db.prepare(`INSERT INTO version_records
    (id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
    VALUES(?,?,0,'complete','human',?,'verbatim','user_written',1,1,?)`)
  const slot = db.prepare(`INSERT INTO slots
    (id,chat_id,parent_slot_id,depth,selected_version_id,fork_id,created_at) VALUES(?,?,?,?,?,?,1)`)
  const event = db.prepare(`INSERT INTO state_events
    (id,chat_id,slot_id,seq,key,value_json,origin,fork_id,fork_seq,created_at) VALUES(?,?,?,?,?,?,'user',?,?,1)`)
  let seq = (db.prepare("SELECT state_seq FROM chats WHERE id=?").get(chatId) as { state_seq: number }).state_seq
  let parent: string | null = null
  for (let i = 1; i <= count; i++) {
    const id = `${chatId}-scale-${i}`
    version.run(`${id}-v`, id, `Synthetic harbour line ${i}.`, forkId)
    slot.run(id, chatId, parent, i - 1, `${id}-v`, forkId)
    for (const key of ["cards.rotation", "reply.single"]) {
      seq++
      event.run(`${id}-${key}`, chatId, id, seq, key, JSON.stringify({ on: i % 2 === 1 }), forkId, seq)
    }
    parent = id
  }
  db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(parent, forkId)
  db.prepare("UPDATE chats SET state_seq=? WHERE id=?").run(seq, chatId)
  db.exec("DELETE FROM fork_label_pause")
  rebuildForkLabels(db, chatId)
  db.exec("COMMIT")
  parentPort!.postMessage({ last: parent })
} finally {
  db.close()
}
