// Synthetic performance data is seeded in a worker, outside the browser and server event loops.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { syntheticMarkdown } from "../../server/src/dev/syntheticText.ts"
import { rebuildForkLabels } from "../../server/src/db/forkLabels.ts"
const { file, chats, longCount } = workerData as { file: string; chats: Array<string>; longCount: number }
/** Four-version sentinels plus dense 20–50-swipe messages on every tenth main-path message. */
const versionsAt = (depth: number) => (depth % 50 === 1 ? 4 : depth % 10 === 3 ? 20 + (depth % 31) : 1)
const htmlAt = (depth: number) => depth % 997 === 0

const fill = (db: DatabaseSync, chatId: string, count: number, seed: number) => {
  const insertVersion = db.prepare(
    `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, error_json, created_at, updated_at, authoring_fork_id)
     VALUES (?, ?, ?, ?, ?, ?, 'verbatim', ?, ?, ?, ?, ?)`
  )
  const insertSlot = db.prepare(
    `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, fork_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const start = Date.now() - count * 60_000
  const slots: Array<string> = []
  /** The version each slot on the main path shows. */
  const versions: Array<string> = []
  let parent: string | null = null
  let lastSelected = ""
  const message = (depth: number, parentId: string | null, branchSeed = 0, forkId = chatId) => {
    const at = start + depth * 60_000
    const slotId = uuidv7()
    const model = depth % 2 === 1
    const words = model ? 40 + ((depth * 7919 + branchSeed) % 220) : 8 + ((depth * 104729 + branchSeed) % 60)
    let selected = ""
    for (
      let ordinal = 0;
      ordinal < (model ? (forkId === chatId ? versionsAt(depth) : 20 + (depth % 31)) : 1);
      ordinal++
    ) {
      const id = uuidv7()
      const failed = ordinal === 1
      let content = syntheticMarkdown(seed + depth * 31 + ordinal + branchSeed, failed ? 20 : words)
      if (htmlAt(depth)) content = `<div class="status">HP <b>12</b> · Mood: wary</div>\n\n${content}`
      insertVersion.run(
        id,
        slotId,
        ordinal,
        failed ? "failed" : "complete",
        model ? "model" : "human",
        content,
        model ? "generated" : "user_written",
        failed ? JSON.stringify({ class: "network", message: "connection reset" }) : null,
        at,
        at,
        forkId
      )
      if (!failed) selected = id
    }
    insertSlot.run(slotId, chatId, parentId, depth, selected, forkId, at)
    lastSelected = selected
    return slotId
  }
  for (let depth = 0; depth < count; depth++) {
    parent = message(depth, parent)
    slots.push(parent)
    versions.push(lastSelected)
    // Now and then an older branch: three messages off the main path.
    if (depth % 5000 === 2500) {
      let side = parent
      for (let i = 1; i <= 3; i++) side = message(depth + i, side, 7)
    }
  }
  if (count >= 3000) {
    const fork = db.prepare(
      "INSERT INTO forks(id,chat_id,parent_fork_id,base_slot_id,tip_slot_id,name,created_at) VALUES(?,?,?,?,?,?,?)"
    )
    const tip = db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?")
    for (let branch = 1; branch < 200; branch++) {
      const base = 2999 + (branch % 10) * 200
      const forkId = `${chatId}-branch-${branch}`
      let leaf = slots[base]!
      fork.run(forkId, chatId, chatId, leaf, leaf, `Voyage branch ${branch}`, start + branch)
      for (let n = 1; n <= 100; n++) leaf = message(base + n, leaf, branch, forkId)
      tip.run(leaf, forkId)
    }
  }
  db.prepare(
    "UPDATE chats SET active_leaf_slot_id = ?, last_message_at = ?, row_version = row_version + 1 WHERE id = ?"
  ).run(parent, Date.now(), chatId)
  return { slots, versions }
}

/**
 * Summaries over the first `covered` messages as the summarizer would leave them: level 1
 * over 16 messages each, and four levels of fives above, so the layer is the nine of level 4.
 */
const summarize = (
  db: DatabaseSync,
  chatId: string,
  path: { slots: Array<string>; versions: Array<string> },
  covered: number
) => {
  const revision = db.prepare(
    "INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at) VALUES (?, ?, ?, ?, 'generated', ?)"
  )
  const summary = db.prepare(
    `INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?)`
  )
  const input = db.prepare(
    "INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id, amend_count) VALUES (?, ?, ?, ?, 0)"
  )
  const parent = db.prepare(
    "INSERT INTO summary_parents (summary_id, ordinal, parent_id, parent_revision_id) VALUES (?, ?, ?, ?)"
  )
  const seal = db.prepare("UPDATE summaries SET sealed = 1 WHERE id = ?")
  interface Made {
    id: string
    revision: string
    first: string
    last: string
    count: number
  }
  const make = (level: number, first: string, last: string, count: number, text: string): Made => {
    const id = uuidv7()
    const revisionId = uuidv7()
    const now = Date.now()
    revision.run(revisionId, id, text, Math.ceil(text.length / 4), now)
    summary.run(id, chatId, level, revisionId, first, last, count, now)
    return { id, revision: revisionId, first, last, count }
  }
  let level: Array<Made> = []
  for (let at = 0; at + 16 <= covered; at += 16) {
    const made = make(1, path.slots[at]!, path.slots[at + 15]!, 16, syntheticMarkdown(at, 90))
    for (let i = 0; i < 16; i++) input.run(made.id, i, path.slots[at + i]!, path.versions[at + i]!)
    seal.run(made.id)
    level.push(made)
  }
  for (let depth = 2; depth <= 4; depth++) {
    const next: Array<Made> = []
    for (let at = 0; at + 5 <= level.length; at += 5) {
      const group = level.slice(at, at + 5)
      const made = make(
        depth,
        group[0]!.first,
        group[4]!.last,
        group.reduce((n, g) => n + g.count, 0),
        syntheticMarkdown(at + depth, 120)
      )
      group.forEach((child, i) => parent.run(made.id, i, child.id, child.revision))
      seal.run(made.id)
      next.push(made)
    }
    level = next
  }
}

const db = new DatabaseSync(file)
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF; PRAGMA cache_size=-262144; PRAGMA temp_store=MEMORY; BEGIN; INSERT INTO fork_label_pause VALUES(1)"
)
const [long, a, b, summarized] = chats as [string, string, string, string]
const { slots: longSlots } = fill(db, long, longCount, 1)
fill(db, a, 300, 2)
fill(db, b, 300, 3)
for (const chatId of [long, a, b])
  db.prepare(
    `INSERT INTO state_events (id,chat_id,seq,key,value_json,origin,created_at)
    SELECT ?,?,coalesce(max(seq),0)+1,'lcm.settings','{"enabled":false}','user',? FROM state_events
    WHERE chat_id=? AND slot_id IS NULL`
  ).run(uuidv7(), chatId, Date.now(), chatId)
const voyage = fill(db, summarized, 20_000, 4)
summarize(db, summarized, voyage, 18_000)
db.exec("DELETE FROM fork_label_pause")
for (const chat of chats) rebuildForkLabels(db, chat)
const shape = chats.map((chatId) => ({
  chatId,
  ...db
    .prepare(
      `SELECT (SELECT count(*) FROM slots WHERE chat_id=?) AS slots,
    (SELECT count(*) FROM forks WHERE chat_id=?) AS branches,
    (SELECT count(*) FROM versions v JOIN slots s ON s.id=v.slot_id WHERE s.chat_id=?) AS versions`
    )
    .get(chatId, chatId, chatId)
}))
db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
parentPort!.postMessage({ longSlots, voyage, shape })
