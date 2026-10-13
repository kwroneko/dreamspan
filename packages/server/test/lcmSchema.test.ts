import { lcm } from "../src/db/schema/lcm.ts"
// Invariants the schema enforces by itself (DATA-MODEL.md §15), tested on a bare
// connection so no application code is involved.
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  accounts,
  bin,
  binIndex,
  credentials,
  dataModel,
  draftHistory,
  graphIntegrity,
  ownership,
  providers,
  queue,
  secretBindings,
  users
} from "../src/db/schema/index.ts"

let db: DatabaseSync
let n = 0
const id = (prefix: string) => `${prefix}${++n}`
const now = () => 1_000 + n

const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params)
const get = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).get(...params) as T
const all = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).all(...params) as Array<T>

/** Runs `f` in a transaction, so deferred foreign keys are checked at commit. */
const tx = (f: () => void) => {
  db.exec("BEGIN IMMEDIATE")
  try {
    f()
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const user = () => {
  const userId = id("u")
  run(
    `INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, 'admin', ?)`,
    userId,
    userId,
    userId,
    now()
  )
  return userId
}

const chat = (ownerId: string, status = "active") => {
  const chatId = id("c")
  const laneId = id("l")
  tx(() => {
    run(
      `INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (?, ?, 'rp', ?, ?)`,
      chatId,
      ownerId,
      status,
      now()
    )
    run(`INSERT INTO lanes (id, chat_id, name, created_at) VALUES (?, ?, 'main', ?)`, laneId, chatId, now())
  })
  return { chatId, laneId }
}

const versionSql = `INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'verbatim', ?, ?, ?)`

/** Appends a slot with one version: the version first, then the slot (deferred keys). */
const slot = (
  c: { chatId: string; laneId: string },
  parent: { slotId: string; depth: number } | null,
  version: { writer?: "human" | "model"; content?: string; status?: string } = {}
) => {
  const slotId = id("s")
  const versionId = id("v")
  const depth = parent ? parent.depth + 1 : 0
  const writer = version.writer ?? "human"
  tx(() => {
    run(
      versionSql,
      versionId,
      slotId,
      0,
      version.status ?? "complete",
      writer,
      version.content ?? "",
      writer === "model" ? "generated" : "user_written",
      now(),
      now()
    )
    run(
      `INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      slotId,
      c.chatId,
      c.laneId,
      parent?.slotId ?? null,
      depth,
      versionId,
      now()
    )
  })
  return { slotId, versionId, depth }
}

beforeEach(() => {
  db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const statement of [
    ...users,
    ...dataModel,
    ...draftHistory,
    ...bin,
    ...providers,
    ...credentials,
    ...accounts,
    ...secretBindings,
    ...binIndex,
    ...graphIntegrity,
    ...ownership,
    ...queue,
    ...lcm
  ])
    db.exec(statement)
})

afterEach(() => db.close())
const summary = (c: ReturnType<typeof chat>, input: ReturnType<typeof slot>, level = 1) => {
  const summaryId = id("sum"),
    revisionId = id("rev")
  tx(() => {
    run(
      `INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'summary',3,'generated',1)`,
      revisionId,
      summaryId
    )
    run(
      `INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,created_at) VALUES(?,?,?,?,?,?,1,1)`,
      summaryId,
      c.chatId,
      level,
      revisionId,
      input.slotId,
      input.slotId
    )
  })
  return { summaryId, revisionId }
}
const setup = () => {
  const c = chat(user())
  const s = slot(c, null)
  const a = summary(c, s)
  const b = summary(c, s, 2)
  return { c, s, a, b }
}
const input = (a: ReturnType<typeof summary>, s: ReturnType<typeof slot>, versionId: string | null = s.versionId) =>
  run(
    `INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,0,?,?)`,
    a.summaryId,
    s.slotId,
    versionId
  )
const parent = (b: ReturnType<typeof summary>, a: ReturnType<typeof summary>, revisionId = a.revisionId) =>
  run(
    `INSERT INTO summary_parents(summary_id,parent_id,ordinal,parent_revision_id) VALUES(?,?,0,?)`,
    b.summaryId,
    a.summaryId,
    revisionId
  )

describe("0019 lineage and retention triggers", () => {
  it("accepts absent effective inputs but refuses a version of another slot", () => {
    const { c, s, a } = setup()
    const other = slot(c, s)
    expect(() => input(a, s, other.versionId)).toThrow(/version must be in its slot/)
    input(a, s, null)
  })
  it("checks child revision ownership on insert", () => {
    const { a, b } = setup()
    expect(() => parent(b, a, b.revisionId)).toThrow(/revision of its child/)
    parent(b, a)
  })
  for (const table of ["summary_inputs", "summary_parents"]) {
    it(`${table} cannot be updated`, () => {
      const { a, b, s } = setup()
      input(a, s)
      parent(b, a)
      expect(() => run(`UPDATE ${table} SET ordinal = ordinal + 1`)).toThrow(/immutable/)
    })
    it(`${table} cannot be deleted while its chat exists`, () => {
      const { a, b, s } = setup()
      input(a, s)
      parent(b, a)
      expect(() => run(`DELETE FROM ${table}`)).toThrow(/as long as/)
    })
  }
  for (const table of ["summaries", "summary_revisions"])
    it(`${table} cannot be deleted separately`, () => {
      setup()
      expect(() => run(`DELETE FROM ${table}`)).toThrow(/as long as/)
    })
  it("summary fields are immutable, and status changes only to superseded", () => {
    const { a } = setup()
    for (const assignment of [
      "level=9",
      "slot_count=2",
      "error_json='{}'",
      "batch_id='x'",
      "status='failed'",
      "created_at=2",
      "audience_json='[]'"
    ])
      expect(() => run(`UPDATE summaries SET ${assignment} WHERE id = ?`, a.summaryId)).toThrow(/only summary/)
    run(`UPDATE summaries SET status='superseded',row_version=2 WHERE id=?`, a.summaryId)
    expect(() => run(`UPDATE summaries SET status='complete' WHERE id=?`, a.summaryId)).toThrow(/only summary/)
  })
  for (const event of ["insert", "update"])
    it(`job leaf stays in its chat on ${event}`, () => {
      const { c, s } = setup()
      const other = slot(chat(user()), null)
      const insert = `INSERT INTO summarization_jobs(id,chat_id,level,first_slot_id,last_slot_id,leaf_slot_id,target_token_count,created_at,updated_at) VALUES('job',?,1,?,?,?,600,1,1)`
      if (event === "insert")
        expect(() => run(insert, c.chatId, s.slotId, s.slotId, other.slotId)).toThrow(/leaf must be in its chat/)
      else {
        run(insert, c.chatId, s.slotId, s.slotId, s.slotId)
        expect(() => run(`UPDATE summarization_jobs SET leaf_slot_id=?`, other.slotId)).toThrow(
          /leaf must be in its chat/
        )
      }
    })
  for (const table of ["summaries", "summary_revisions", "summary_inputs", "summary_parents"])
    it(`${table} refuses INSERT OR REPLACE with recursive triggers off`, () => {
      const { a, b, s } = setup()
      input(a, s)
      parent(b, a)
      expect(get<{ recursive_triggers: number }>("PRAGMA recursive_triggers").recursive_triggers).toBe(0)
      expect(() => run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/cannot be replaced/)
    })
  it("chat deletion cascades through retained summaries, revisions, lineage and search", () => {
    const { c, s, a, b } = setup()
    input(a, s)
    parent(b, a)
    run(`DELETE FROM chats WHERE id=?`, c.chatId)
    for (const table of ["summaries", "summary_revisions", "summary_inputs", "summary_parents"])
      expect(get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n).toBe(0)
    expect(all(`PRAGMA foreign_key_check`)).toEqual([])
    expect(all(`SELECT rowid FROM summary_revisions_fts WHERE summary_revisions_fts MATCH 'summary'`)).toEqual([])
  })
})
describe("foreign keys", () => {
  // Rows of these tables are never deleted (entities and connections stay as tombstones).
  const neverDeleted = new Set(["users", "media_assets", "models", "entities", "connections"])

  it("are indexed on the referencing side wherever the referenced row can be deleted", () => {
    const unindexed: Array<string> = []
    for (const { name } of all<{ name: string }>(`SELECT name FROM sqlite_schema WHERE type = 'table'`)) {
      const leading = new Set(
        all<{ name: string }>(`SELECT name FROM pragma_index_list(?)`, name).map(
          (index) => get<{ name: string }>(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, index.name).name
        )
      )
      for (const fk of all<{ from: string; table: string }>(`SELECT * FROM pragma_foreign_key_list(?)`, name)) {
        if (!neverDeleted.has(fk.table) && !leading.has(fk.from)) unindexed.push(`${name}.${fk.from}`)
      }
    }
    expect(unindexed).toEqual([])
  })
})
