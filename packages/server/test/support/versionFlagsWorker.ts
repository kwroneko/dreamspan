// Disposable synthetic benchmark databases only; all synchronous SQLite stays in this worker.
import { parentPort, workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { shellSlotsQuery } from "../../src/db/shellQueries.ts"

const {
  file,
  chatId: suppliedChat,
  forkId: suppliedFork,
  parent,
  messages,
  swipes,
  realistic,
  probe
} = workerData as {
  file: string
  chatId: string
  forkId: string
  parent: string
  messages: number
  swipes: number
  realistic: boolean
  probe: boolean
}
const db = new DatabaseSync(file)
const chatId = suppliedChat || (db.prepare("SELECT id FROM chats LIMIT 1").get() as { id: string }).id
const forkId =
  suppliedFork || (db.prepare("SELECT current_fork_id AS id FROM chats WHERE id=?").get(chatId) as { id: string }).id
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA cache_size=-262144; PRAGMA temp_store=MEMORY")
  if (!probe) {
    const version =
      db.prepare(`INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,reasoning,macro_mode,origin,created_at,updated_at)
      VALUES(?,?,?,'complete',?,?,?,'verbatim',?,1,1)`)
    const slot = db.prepare(`INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
      VALUES(?,?,?,?,?,1,?)`)
    const start = (db.prepare("SELECT depth FROM slots WHERE id=?").get(parent) as { depth: number }).depth + 1
    const prose =
      "The lantern shone across the quiet courtyard. A traveller stopped beside the gate and listened to the rain. "
    const reasoning =
      "Consider the characters' intentions, the setting, continuity and the next response. Preserve their distinct voices. "
    let previous = parent
    db.exec("BEGIN")
    for (let i = 0; i < messages; i++) {
      const id = `study-s${i}`
      const model = i % 2 === 1
      const count = model ? swipes : 1
      for (let j = 0; j < count; j++) {
        const replyLength = realistic ? (model ? 2000 + ((i * 101 + j * 313) % 6001) : 400) : 142
        const reasonLength = realistic && model ? 5000 + ((i * 307 + j * 719) % 15001) : 0
        version.run(
          `${id}-v${j}`,
          id,
          j,
          model ? "model" : "human",
          prose.repeat(Math.ceil(replyLength / prose.length)).slice(0, replyLength),
          reasonLength ? reasoning.repeat(Math.ceil(reasonLength / reasoning.length)).slice(0, reasonLength) : null,
          model ? "generated" : "user_written"
        )
      }
      slot.run(id, chatId, previous, start + i, `${id}-v${count - 1}`, forkId)
      if (i % 20 === 1) {
        const original = `${id}-v${count - 1}`
        const copy = `${id}-copy`
        db.prepare(
          `INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,reasoning,macro_mode,origin,
          source_version_id,fork_id,created_at,updated_at)
          SELECT ?,slot_id,?,'complete','human',content,reasoning,'verbatim','edited',id,?,1,1 FROM version_records WHERE id=?`
        ).run(copy, count, forkId, original)
        const seq = (
          db.prepare("UPDATE chats SET state_seq=state_seq+1 WHERE id=? RETURNING state_seq").get(chatId) as {
            state_seq: number
          }
        ).state_seq
        db.prepare(
          `INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
          VALUES(?,?,?,?,'replace',?,?,?,?)`
        ).run(`${id}-replace`, chatId, forkId, seq, original, id, start + i, copy)
      }
      previous = id
    }
    db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(previous, forkId)
    db.exec(`CREATE TABLE version_flag_probe AS SELECT id,slot_id,deleted_at,purged_at,fork_id,hidden FROM versions;
      CREATE UNIQUE INDEX probe_id ON version_flag_probe(id); CREATE INDEX probe_slot ON version_flag_probe(slot_id); CREATE INDEX probe_fork ON version_flag_probe(fork_id) WHERE fork_id IS NOT NULL; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`)
    parentPort!.postMessage({ versions: (db.prepare("SELECT count(*) AS n FROM versions").get() as { n: number }).n })
  } else {
    const queries: Record<string, { sql: string; params: Array<string> }> = {
      "selected-flags": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN versions v ON v.id=s.selected_version_id WHERE s.chat_id=?",
        params: [chatId]
      },
      "selected-narrow-control": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN version_flag_probe v ON v.id=s.selected_version_id WHERE s.chat_id=?",
        params: [chatId]
      },
      "swipe-flags": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN versions v ON v.slot_id=s.id WHERE s.chat_id=? AND s.depth >= ?",
        params: [chatId, String(messages - 200)]
      },
      "swipe-narrow-control": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN version_flag_probe v ON v.slot_id=s.id WHERE s.chat_id=? AND s.depth >= ?",
        params: [chatId, String(messages - 200)]
      },
      "all-swipe-flags": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN versions v ON v.slot_id=s.id WHERE s.chat_id=?",
        params: [chatId]
      },
      "all-swipe-narrow-control": {
        sql: "SELECT v.deleted_at,v.purged_at,v.fork_id,v.hidden FROM slots s JOIN version_flag_probe v ON v.slot_id=s.id WHERE s.chat_id=?",
        params: [chatId]
      },
      "fork-copy-flags": {
        sql: "SELECT deleted_at,purged_at,fork_id,hidden FROM versions WHERE fork_id=?",
        params: [forkId]
      },
      "fork-copy-narrow-control": {
        sql: "SELECT deleted_at,purged_at,fork_id,hidden FROM version_flag_probe WHERE fork_id=?",
        params: [forkId]
      },
      "shell-sql": { sql: shellSlotsQuery, params: [JSON.stringify([forkId])] }
    }
    const metrics: Record<string, unknown> = {}
    for (const [name, query] of Object.entries(queries)) {
      const statement = db.prepare(query.sql)
      const runs: number[] = []
      let rows = 0
      for (let i = 0; i < 8; i++) {
        if (i === 0) db.exec("PRAGMA shrink_memory")
        const at = performance.now()
        rows = statement.all(...query.params).length
        runs.push(performance.now() - at)
      }
      metrics[name] = {
        rows,
        sqliteColdMs: runs[0],
        warmMs: runs.slice(1).sort((a, b) => a - b)[3],
        runs,
        plan: db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params)
      }
    }
    parentPort!.postMessage(metrics)
  }
} finally {
  db.close()
}
