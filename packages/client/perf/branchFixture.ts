import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { rebuildForkLabels } from "../../server/src/db/forkLabels.ts"
const { file, chat } = workerData as { file: string; chat: string }
const db = new DatabaseSync(file)
db.exec("PRAGMA foreign_keys=ON; BEGIN; INSERT INTO fork_label_pause VALUES (1)")
const v = db.prepare(
  "INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at) VALUES(?,?,?,'complete',?,?,'verbatim','user_written',?,?)"
)
const s = db.prepare(
  "INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,fork_id,created_at) VALUES(?,?,?,?,?,?,?)"
)
const start = Date.now() - 3000 * 60000
let parent = null
for (let i = 0; i < 3000; i++) {
  const id = `${chat}-s${i}`
  for (let j = 0; j < (i % 2 ? 30 : 1); j++)
    v.run(
      `${id}-v${j}`,
      id,
      j,
      i % 2 ? "model" : "human",
      `Message ${i + 1}, version ${j + 1}. The travelers followed the river through the quiet valley.\n\n` +
        "Lanterns glowed along the path as they discussed the next stage of their journey. ".repeat(i % 2 ? 8 : 2),
      start + i * 60000,
      start + i * 60000
    )
  s.run(id, chat, parent, i, `${id}-v0`, chat, start + i * 60000)
  parent = id
}
db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(parent, chat)
const fork = db.prepare(
  "INSERT INTO forks(id,chat_id,parent_fork_id,base_slot_id,tip_slot_id,name,created_at) VALUES(?,?,?,?,?,?,?)"
)
for (let b = 1; b < 500; b++) {
  const f = `${chat}-f${b}`,
    id = `${f}-s`
  fork.run(f, chat, chat, `${chat}-s2998`, `${chat}-s2998`, `Branch ${String(b).padStart(3, "0")}`, start + b)
  for (let j = 0; j < 30; j++)
    v.run(
      `${id}-v${j}`,
      id,
      j,
      "model",
      `Branch ${b}, version ${j + 1}. ` + "The river wound through the valley beneath the stars. ".repeat(12),
      start + 3000 * 60000 + b,
      start + 3000 * 60000 + b
    )
  s.run(id, chat, `${chat}-s2998`, 2999, `${id}-v0`, f, start + 3000 * 60000 + b)
  db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(id, f)
}
db.prepare(
  "INSERT INTO state_events(id,chat_id,seq,key,value_json,origin,created_at) VALUES(?,?,1,'lcm.settings','{\"enabled\":false}','user',?)"
).run(`${chat}-lcm`, chat, Date.now())
db.exec("DELETE FROM fork_label_pause")
rebuildForkLabels(db, chat)
db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
parentPort!.postMessage({ branches: 500, messages: 3000, swipes: 30 })
