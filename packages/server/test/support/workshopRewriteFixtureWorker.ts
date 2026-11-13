// Synthetic relational fixture at the owner's scale; SQLite stays in this worker.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { rebuildForkLabels } from "../../src/db/forkLabels.ts"
const { dbPath, chatId, forkId, messages, branches } = workerData as {
  dbPath: string
  chatId: string
  forkId: string
  messages: number
  branches: number
}
const db = new DatabaseSync(dbPath)
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; BEGIN IMMEDIATE; INSERT INTO fork_label_pause VALUES(1)")
try {
  const version = db.prepare(
    "INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,authoring_fork_id,created_at,updated_at) VALUES(?,?,?,'complete','human',?,'verbatim','user_written',?,1,1)"
  )
  const slot = db.prepare(
    "INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,fork_id,created_at) VALUES(?,?,?,?,?,?,1)"
  )
  let parent: string | null = null
  let versions = 0
  for (let n = 0; n < messages; n++) {
    const id = `${chatId}-s${n}`
    for (let swipe = 0; swipe < 20 + (n % 31); swipe++) {
      version.run(`${id}-v${swipe}`, id, swipe, `Aria in garden ${n}, swipe ${swipe}.`, forkId)
      versions++
    }
    slot.run(id, chatId, parent, n, `${id}-v0`, forkId)
    parent = id
  }
  db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(parent, forkId)
  const fork = db.prepare(
    "INSERT INTO forks(id,chat_id,parent_fork_id,base_slot_id,tip_slot_id,branched_at,created_at) VALUES(?,?,?,?,?,0,1)"
  )
  for (let n = 1; n < branches; n++) fork.run(`${chatId}-f${n}`, chatId, forkId, parent, parent)
  db.prepare("UPDATE chats SET active_leaf_slot_id=?,current_fork_id=? WHERE id=?").run(parent, forkId, chatId)
  rebuildForkLabels(db, chatId)
  db.exec("DELETE FROM fork_label_pause; COMMIT")
  parentPort!.postMessage({ versions, messages, branches })
} catch (error) {
  db.exec("ROLLBACK")
  throw error
} finally {
  db.close()
}
