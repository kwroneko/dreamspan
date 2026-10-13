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
const summary = (c: ReturnType<typeof chat>, input: ReturnType<typeof slot>, level = 1, last = input, count = 1) => {
  const summaryId = id("sum"),
    revisionId = id("rev")
  tx(() => {
    run(
      `INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'summary',3,'generated',1)`,
      revisionId,
      summaryId
    )
    run(
      `INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,created_at) VALUES(?,?,?,?,?,?,?,1)`,
      summaryId,
      c.chatId,
      level,
      revisionId,
      input.slotId,
      last.slotId,
      count
    )
  })
  return { summaryId, revisionId }
}
const seal = (s: ReturnType<typeof summary>) => run("UPDATE summaries SET sealed=1 WHERE id=?", s.summaryId)
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

describe("0023 lineage and retention triggers", () => {
  it("accepts absent effective inputs but refuses a version of another slot", () => {
    const { c, s, a } = setup()
    const other = slot(c, s)
    expect(() => input(a, s, other.versionId)).toThrow(/version must be in its slot/)
    input(a, s, null)
  })
  it("checks child revision ownership on insert", () => {
    const { a, b, s } = setup()
    input(a, s)
    seal(a)
    expect(() => parent(b, a, b.revisionId)).toThrow(/revision of its child/)
    parent(b, a)
  })
  for (const table of ["summary_inputs", "summary_parents"]) {
    it(`${table} cannot be updated`, () => {
      const { a, b, s } = setup()
      input(a, s)
      seal(a)
      parent(b, a)
      expect(() => run(`UPDATE ${table} SET ordinal = ordinal + 1`)).toThrow(/immutable/)
    })
    it(`${table} cannot be deleted while its chat exists`, () => {
      const { a, b, s } = setup()
      input(a, s)
      seal(a)
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
      seal(a)
      parent(b, a)
      expect(get<{ recursive_triggers: number }>("PRAGMA recursive_triggers").recursive_triggers).toBe(0)
      expect(() => run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/cannot be replaced/)
    })
  it("chat deletion cascades through retained summaries, revisions, lineage and search", () => {
    const { c, s, a, b } = setup()
    input(a, s)
    seal(a)
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

describe("review: malformed lineage", () => {
  it("rejects endpoints on different branches despite matching depths", () => {
    const { c, s } = setup(),
      middle = slot(c, s),
      fork = slot(c, s),
      end = slot(c, middle)
    expect(() =>
      tx(() => {
        run(
          "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES('bad-rev','bad','bad',1,'generated',1)"
        )
        run(
          "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,created_at) VALUES('bad',?,1,'bad-rev',?,?,2,1)",
          c.chatId,
          fork.slotId,
          end.slotId
        )
      })
    ).toThrow()
  })
  it("rejects self-reference and children at the same or higher level", () => {
    const { c, s, a, b } = setup()
    input(a, s)
    seal(a)
    parent(b, a)
    seal(b)
    const same = summary(c, s, 2),
      higher = summary(c, s, 1)
    expect(() => parent(same, b)).toThrow(/strictly lower/)
    expect(() => parent(higher, b)).toThrow(/strictly lower/)
    expect(() => parent(same, same)).toThrow(/strictly lower/)
    parent(same, a)
    seal(same)
  })
  it("rejects inputs beyond the declared chain", () => {
    const { c, s, a } = setup(),
      after = slot(c, s)
    input(a, s)
    expect(() =>
      run(
        "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,1,?,?)",
        a.summaryId,
        after.slotId,
        after.versionId
      )
    ).toThrow()
  })
})

describe("lineage publication", () => {
  it("seals complete ordered inputs, rejects gaps and wrong endpoints, and cannot reopen", () => {
    const { c, s } = setup(),
      middle = slot(c, s),
      end = slot(c, middle),
      fork = slot(c, s)
    const a = summary(c, s, 1, end, 3)
    expect(() => seal(a)).toThrow(/entire chain/)
    expect(() => input(a, middle)).toThrow(/follow.*chain/)
    input(a, s)
    expect(() => seal(a)).toThrow(/entire chain/)
    const add = (ordinal: number, v: typeof s) =>
      run(
        "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,?,?,?)",
        a.summaryId,
        ordinal,
        v.slotId,
        v.versionId
      )
    expect(() => add(2, end)).toThrow(/follow.*chain/)
    expect(() => add(1, end)).toThrow(/follow.*chain/)
    add(1, middle)
    add(2, end)
    seal(a)
    expect(() => run("UPDATE summaries SET sealed=0 WHERE id=?", a.summaryId)).toThrow(/only summary/)
    expect(() => add(3, slot(c, end))).toThrow()
    const wrong = summary(c, s, 1, middle, 2)
    input(wrong, s)
    run(
      "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES(?,1,?,?)",
      wrong.summaryId,
      fork.slotId,
      fork.versionId
    )
    expect(() => seal(wrong)).toThrow(/entire chain/)
  })
  it("seals only a complete lower-level partition and closes child appends", () => {
    const { c, s, a } = setup(),
      next = slot(c, s),
      last = slot(c, next)
    input(a, s)
    seal(a)
    const b = summary(c, next),
      extra = summary(c, last),
      high = summary(c, s, 2, next, 2)
    input(b, next)
    seal(b)
    input(extra, last)
    seal(extra)
    expect(() => seal(high)).toThrow(/entire chain/)
    expect(() => parent(high, b)).toThrow(/partition/)
    parent(high, a)
    expect(() => seal(high)).toThrow(/entire chain/)
    run(
      "INSERT INTO summary_parents(summary_id,parent_id,ordinal,parent_revision_id) VALUES(?,?,1,?)",
      high.summaryId,
      b.summaryId,
      b.revisionId
    )
    seal(high)
    expect(() =>
      run(
        "INSERT INTO summary_parents(summary_id,parent_id,ordinal,parent_revision_id) VALUES(?,?,2,?)",
        high.summaryId,
        extra.summaryId,
        extra.revisionId
      )
    ).toThrow(/closed/)
  })
  it("cannot bypass publication by inserting an already sealed summary", () => {
    const { c, s } = setup()
    expect(() =>
      tx(() => {
        run(
          "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES('sealed-rev','sealed','bad',1,'generated',1)"
        )
        run(
          "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,sealed,created_at) VALUES('sealed',?,1,'sealed-rev',?,?,1,1,1)",
          c.chatId,
          s.slotId,
          s.slotId
        )
      })
    ).toThrow(/sealed after insertion/)
  })
})
