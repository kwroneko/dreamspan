// Relational copy of writeStBranchFamily's synthetic data. Only setup runs here;
// every measured operation uses the application's normal reader/writer workers.
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { writeStBranchFamily } from "./stFolder.ts"

const { dbPath, root, chatId, messages, branches, note, revision } = workerData as {
  dbPath: string
  root: string
  chatId: string
  messages: number
  branches: number
  note: string
  revision: string
}
const fixture = writeStBranchFamily(root, { branches: branches - 1, messages, swipeShare: 0.8, bodyRepeats: 1 })
const db = new DatabaseSync(dbPath)
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; PRAGMA cache_size=-524288; PRAGMA temp_store=MEMORY; BEGIN IMMEDIATE"
)
try {
  const lane = (db.prepare("SELECT id FROM lanes WHERE chat_id=?").get(chatId) as { id: string }).id
  const version =
    db.prepare(`INSERT INTO versions(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at)
    VALUES(?,?,?,'complete',?,?,'verbatim',?,1,1)`)
  const slot =
    db.prepare(`INSERT INTO slots(id,chat_id,lane_id,parent_slot_id,depth,selected_version_id,fork_id,inserted,created_at)
    VALUES(?,?,?,?,?,?,?,?,1)`)
  const fork =
    db.prepare(`INSERT INTO forks(id,chat_id,parent_fork_id,base_slot_id,tip_slot_id,branched_at,lineage_json,created_at)
    VALUES(?,?,?,?,?,?,?,1)`)
  const override =
    db.prepare(`INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id,flag)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  const event =
    db.prepare(`INSERT INTO state_events(id,chat_id,slot_id,seq,key,value_json,origin,fork_id,fork_seq,created_at)
    VALUES(?,?,?,?,?,?,'user',?,?,1)`)
  const paths: Array<Array<{ id: string; selected: string; versions: number }>> = []
  const lineages: Array<Array<[string, number | null]>> = []
  let seq = 10
  let versions = 0
  let overrides = 0
  let events = 0
  const mainInsertions = new Map<number, string>()
  const forkId = (n: number) => (n === 0 ? chatId : `${chatId}-f${n}`)
  const put = (
    f: string,
    kind: string,
    target: string,
    s: string | null,
    depth: number | null,
    value: string | null,
    flag: number | null
  ) => override.run(`${chatId}-o${++overrides}`, chatId, f, ++seq, kind, target, s, depth, value, flag)
  for (const [b, file] of fixture.files.entries()) {
    const f = forkId(b)
    const inherited = b === 0 ? [] : lineages[file.parent]!.map(([id, bound]) => [id, bound ?? seq] as [string, number])
    const lineage: Array<[string, number | null]> = [[f, null], ...inherited]
    lineages.push(lineage)
    const path = b === 0 ? [] : paths[file.parent]!.slice(0, file.prefix)
    const base = path.at(-1)?.id ?? null
    if (b > 0) fork.run(f, chatId, forkId(file.parent), base, base, seq, JSON.stringify(lineage))
    const lines = readFileSync(join(root, file.path), "utf8").split("\n")
    for (let depth = file.prefix; depth < messages; depth++) {
      const row = JSON.parse(lines[depth + 1]!) as { mes: string; is_user: boolean; swipes?: Array<string> }
      const id = `${chatId}-s${b}-${depth}`
      // Human alternatives make non-default choices possible at most positions too.
      const texts = row.swipes ?? (row.is_user ? [row.mes, `${row.mes} Alternate.`] : [row.mes])
      for (const [i, text] of texts.entries()) {
        version.run(
          `${id}-v${i}`,
          id,
          i,
          row.is_user ? "human" : "model",
          text,
          row.is_user ? "user_written" : "generated"
        )
        versions++
      }
      slot.run(id, chatId, lane, path.at(-1)?.id ?? null, depth, `${id}-v0`, f, 0)
      path.push({ id, selected: `${id}-v${texts.length - 1}`, versions: texts.length })
    }
    paths.push(path)
    db.prepare("UPDATE forks SET tip_slot_id=? WHERE id=?").run(path.at(-1)!.id, f)
    for (const [depth, s] of path.entries()) {
      if (s.versions > 1) put(f, "select", s.id, s.id, depth, s.selected, null)
      if (depth % 7 === 0) put(f, "star", s.selected, s.id, depth, null, 1)
      if (depth % 11 === 0) put(f, "picker_hide", `${s.id}-v0`, s.id, depth, null, 1)
      if (depth % 19 === 0) put(f, "hide", s.id, s.id, depth, null, 1)
      if (depth % 101 === 10 && depth < messages - 1) put(f, "delete_slot", s.id, s.id, depth, null, 1)
      if (depth % 100 === 25) {
        event.run(
          `${chatId}-e${++events}`,
          chatId,
          s.id,
          b + 1,
          "var.set",
          JSON.stringify({ name: `place${depth}`, value: `fork${b}` }),
          f,
          ++seq
        )
      }
    }
    for (let i = 0; i < 8; i++) {
      const depth = Math.floor(((i + 1) * messages) / 10)
      const id = `${f}-insert${i}`
      version.run(`${id}-v0`, id, 0, "human", "An inserted synthetic message.", "user_written")
      slot.run(id, chatId, lane, path[depth]!.id, depth + 1, `${id}-v0`, f, 1)
      put(f, "insert", id, path[depth]!.id, depth, null, 1)
      if (b === 0) mainInsertions.set(depth, id)
      versions++
    }
    event.run(
      `${chatId}-e${++events}`,
      chatId,
      path[25]!.id,
      b + 1000,
      "note.binding",
      JSON.stringify({ note, revision }),
      f,
      ++seq
    )
    event.run(
      `${chatId}-e${++events}`,
      chatId,
      path[25]!.id,
      b + 2000,
      "note.activate",
      JSON.stringify({ note }),
      f,
      ++seq
    )
    if (b % 10 === 0) console.log("FORKCOST_FIXTURE", messages, branches, b)
  }
  // Fresh level-one coverage, with all the main fork's inserted, hidden and deleted
  // positions represented exactly as the real summarizer pins them.
  const inputs = paths[0]!.flatMap((s, depth) => [
    { slot: s.id, version: depth % 19 === 0 || depth % 101 === 10 ? null : s.selected },
    ...(mainInsertions.has(depth)
      ? [{ slot: mainInsertions.get(depth)!, version: `${mainInsertions.get(depth)!}-v0` }]
      : [])
  ])
  const summary =
    db.prepare(`INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at)
    VALUES(?,?,1,?,?,?,?,'complete',1)`)
  const summaryRevision = db.prepare(`INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at)
    VALUES(?,?,'The travelers continued their synthetic journey.',10,'generated',1)`)
  const input = db.prepare(
    "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES(?,?,?,?,0)"
  )
  const summaryIds: Array<string> = []
  for (let at = 0; at + 50 < inputs.length - 20; at += 50) {
    const group = inputs.slice(at, at + 50)
    const id = `${chatId}-summary${at}`
    summaryIds.push(id)
    summaryRevision.run(`${id}-r`, id)
    summary.run(id, chatId, `${id}-r`, group[0]!.slot, group.at(-1)!.slot, group.length)
    group.forEach((s, i) => input.run(id, i, s.slot, s.version))
    db.prepare("UPDATE summaries SET sealed=1 WHERE id=?").run(id)
  }
  db.prepare("UPDATE chats SET current_fork_id=?,state_seq=? WHERE id=?").run(chatId, seq, chatId)
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")
  const result = {
    slots: fixture.uniqueMessages + branches * 8,
    versions,
    overrides,
    events,
    summaryIds,
    main: paths[0],
    generatedBytes: fixture.bytes
  }
  // Retain a synthetic seed for diagnosing a failed large read without losing
  // its expensive setup when the test cleans up its temporary directory.
  if (process.env.FORKCOST_OUT) {
    const destination = `${process.env.FORKCOST_OUT}.seed-${messages}-${branches}`
    copyFileSync(dbPath, destination + ".db")
    writeFileSync(destination + ".json", JSON.stringify({ chatId, ...result }))
  }
  parentPort!.postMessage(result)
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
