// Invariants the schema enforces by itself (DATA-MODEL.md §15), tested on a bare
// connection so no application code is involved.
import { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, it } from "vitest"
import { dataModel, draftHistory, users } from "../src/db/schema/index.ts"

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

const addVersion = (
  slotId: string,
  ordinal: number,
  version: { writer: "human" | "model"; content: string; status?: string }
) => {
  const versionId = id("v")
  run(
    versionSql,
    versionId,
    slotId,
    ordinal,
    version.status ?? "complete",
    version.writer,
    version.content,
    version.writer === "model" ? "generated" : "user_written",
    now(),
    now()
  )
  return versionId
}

beforeEach(() => {
  db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const statement of [...users, ...dataModel, ...draftHistory]) db.exec(statement)
})

describe("graph shape", () => {
  it("rejects a parent from another chat or at the wrong depth", () => {
    const owner = user()
    const a = chat(owner)
    const b = chat(owner)
    const root = slot(a, null)
    expect(() => slot(b, root)).toThrow(/same chat/)
    expect(() => slot(a, { slotId: root.slotId, depth: 5 })).toThrow(/one level up/)
  })

  it("never lets a slot move", () => {
    const c = chat(user())
    const root = slot(c, null)
    const child = slot(c, root)
    const other = slot(c, root)
    expect(() => run(`UPDATE slots SET parent_slot_id = ? WHERE id = ?`, other.slotId, child.slotId)).toThrow(
      /append-only/
    )
  })

  it("only lets a slot select one of its own versions (invariant 3)", () => {
    const c = chat(user())
    const a = slot(c, null)
    const b = slot(c, a)
    expect(() => run(`UPDATE slots SET selected_version_id = ? WHERE id = ?`, b.versionId, a.slotId)).toThrow(
      /own versions/
    )
  })

  it("changing a selection touches only that slot (invariant 3)", () => {
    const c = chat(user())
    const a = slot(c, null, { content: "a0" })
    const b = slot(c, a, { content: "b0" })
    const before = all(`SELECT id, selected_version_id, row_version FROM slots WHERE id <> ? ORDER BY id`, a.slotId)
    const alt = addVersion(a.slotId, 1, { writer: "model", content: "a1" })
    run(`UPDATE slots SET selected_version_id = ?, row_version = row_version + 1 WHERE id = ?`, alt, a.slotId)
    expect(all(`SELECT id, selected_version_id, row_version FROM slots WHERE id <> ? ORDER BY id`, a.slotId)).toEqual(
      before
    )
    expect(
      get<{ parent_slot_id: string }>(`SELECT parent_slot_id FROM slots WHERE id = ?`, b.slotId).parent_slot_id
    ).toBe(a.slotId)
  })

  it("keeps a chat's active leaf inside the chat", () => {
    const owner = user()
    const a = chat(owner)
    const b = chat(owner)
    const s = slot(b, null)
    expect(() => run(`UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?`, s.slotId, a.chatId)).toThrow(
      /active leaf/
    )
  })
})

describe("edits are non-destructive (invariant 1)", () => {
  it("freezes model output once generation ends", () => {
    const c = chat(user())
    const s = slot(c, null, { writer: "model", status: "generating", content: "" })
    run(`UPDATE versions SET content = 'partial text' WHERE id = ?`, s.versionId) // streaming is fine
    run(`UPDATE versions SET content = 'full text', status = 'complete' WHERE id = ?`, s.versionId)
    expect(() => run(`UPDATE versions SET content = 'rewritten' WHERE id = ?`, s.versionId)).toThrow(
      /immutable once generated/
    )
  })

  it("keeps the earlier content of an amended user-written version", () => {
    const c = chat(user())
    const s = slot(c, null, { content: "first draft" })
    run(`UPDATE versions SET content = 'second draft', updated_at = 2 WHERE id = ?`, s.versionId)
    run(`UPDATE versions SET content = 'final', updated_at = 3 WHERE id = ?`, s.versionId)
    expect(
      all<{ content: string }>(`SELECT content FROM version_history WHERE version_id = ? ORDER BY id`, s.versionId).map(
        (r) => r.content
      )
    ).toEqual(["first draft", "second draft"])
  })

  it("allows deliberate deletes, keeping references whole", () => {
    const c = chat(user())
    const s = slot(c, null, { content: "kept" })
    const extra = addVersion(s.slotId, 1, { writer: "model", content: "a swipe to delete" })
    run(`DELETE FROM versions WHERE id = ?`, extra)
    // A slot can't be left pointing at a deleted version.
    expect(() => tx(() => run(`DELETE FROM versions WHERE id = ?`, s.versionId))).toThrow(/FOREIGN KEY/)
  })

  it("deletes a chat with everything in it", () => {
    const owner = user()
    const c = chat(owner)
    const root = slot(c, null, { content: "Hello." })
    const reply = slot(c, root, { writer: "model", content: "Hi." })
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('card', ?, 'card', 1)`, owner)
    run(`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
         VALUES ('rev', 'card', '{}', 'h', 1, 'user', 1)`)
    run(`INSERT INTO entity_refs (id, entity_id, ref_kind, head_revision_id, label, created_at, updated_at)
         VALUES ('base', 'card', 'upstream', 'rev', 'Card', 1, 1)`)
    run(
      `INSERT INTO entity_refs (id, entity_id, ref_kind, head_revision_id, follows_ref_id, merge_base_revision_id, label, chat_id, created_at, updated_at)
         VALUES ('override', 'card', 'chat_override', 'rev', 'base', 'rev', 'Card', ?, 1, 1)`,
      c.chatId
    )
    run(
      `INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at)
         VALUES ('ev', ?, ?, 0, 'var.set', '{}', 'user', 1)`,
      c.chatId,
      reply.slotId
    )
    run(
      `INSERT INTO drafts (id, user_id, target_kind, target_id, field, content, updated_at) VALUES ('d', ?, 'composer', ?, ?, 'unsent', 1)`,
      owner,
      c.chatId,
      reply.slotId
    )
    tx(() => run(`DELETE FROM chats WHERE id = ?`, c.chatId))
    for (const table of ["slots", "versions", "state_events", "drafts", "lanes"]) {
      expect(get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n).toBe(0)
    }
    expect(all<{ id: string }>(`SELECT id FROM entity_refs`).map((r) => r.id)).toEqual(["base"])
  })

  it("never changes an entity revision", () => {
    const owner = user()
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('e1', ?, 'card', 1)`, owner)
    run(`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
         VALUES ('r1', 'e1', '{"name":"Mira"}', 'h1', 1, 'import', 1)`)
    expect(() => run(`UPDATE entity_revisions SET doc_json = '{}' WHERE id = 'r1'`)).toThrow(/immutable/)
  })

  it("freezes a rollout's context snapshot (invariant 6)", () => {
    const c = chat(user())
    run(
      `INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at)
         VALUES ('ro1', ?, 'generation', 'running', 'narrator', 'interactive', 1, 1)`,
      c.chatId
    )
    run(`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json) VALUES ('ro1', '{"parts":[]}')`)
    run(`UPDATE rollout_payloads SET transcript_json = '[]' WHERE rollout_id = 'ro1'`) // transcript flushes are fine
    expect(() => run(`UPDATE rollout_payloads SET context_snapshot_json = '{}' WHERE rollout_id = 'ro1'`)).toThrow(
      /frozen/
    )
  })
})

describe("draft cleanup", () => {
  it("removes drafts along with their targets", () => {
    const owner = user()
    const pending = chat(owner, "pending")
    const greeting = slot(pending, null, { content: "Hello." })
    const draft = (kind: string, target: string) =>
      run(
        `INSERT INTO drafts (id, user_id, target_kind, target_id, field, content, updated_at) VALUES (?, ?, ?, ?, '', 'text', 1)`,
        id("d"),
        owner,
        kind,
        target
      )
    draft("composer", pending.chatId)
    run(
      `INSERT INTO drafts (id, user_id, target_kind, target_id, field, content, updated_at) VALUES (?, ?, 'composer', ?, ?, 'text', 1)`,
      id("d"),
      owner,
      pending.chatId,
      greeting.slotId
    )
    draft("scratchpad", greeting.slotId)
    draft("version_edit", greeting.versionId)
    run(`INSERT INTO draft_history (draft_id, seq, kind, first_at, at, start, removed, inserted)
         SELECT id, 1, 'edit', 1, 1, 0, '', 'text' FROM drafts`)
    run(`DELETE FROM chats WHERE id = ?`, pending.chatId)
    expect(get<{ n: number }>(`SELECT count(*) AS n FROM drafts`).n).toBe(0)
    expect(get<{ n: number }>(`SELECT count(*) AS n FROM draft_history`).n).toBe(0)
  })
})

describe("state events", () => {
  it("must sit on a slot of their chat, with a version of that slot", () => {
    const owner = user()
    const a = chat(owner)
    const b = chat(owner)
    const sa = slot(a, null)
    const sb = slot(b, null)
    const event = `INSERT INTO state_events (id, chat_id, slot_id, version_id, seq, key, value_json, origin, created_at)
      VALUES (?, ?, ?, ?, 0, 'presence.set', '{}', 'user', 1)`
    expect(() => run(event, id("ev"), a.chatId, sb.slotId, null)).toThrow(/state event/)
    expect(() => run(event, id("ev"), a.chatId, sa.slotId, sb.versionId)).toThrow(/state event/)
    run(event, id("ev"), a.chatId, sa.slotId, sa.versionId)
  })
})

describe("full-text search", () => {
  const search = (q: string) =>
    all<{ id: string }>(
      `SELECT v.id FROM versions_fts f JOIN versions v ON v.seq = f.rowid WHERE versions_fts MATCH ? ORDER BY rank`,
      q
    ).map((r) => r.id)

  it("indexes versions once generation ends, and follows amendments", () => {
    const c = chat(user())
    const streaming = slot(c, null, { writer: "model", status: "generating" })
    run(`UPDATE versions SET content = 'the lantern swung low' WHERE id = ?`, streaming.versionId)
    expect(search("lantern")).toEqual([])
    run(`UPDATE versions SET status = 'complete' WHERE id = ?`, streaming.versionId)
    expect(search("lantern")).toEqual([streaming.versionId])

    const typed = slot(c, streaming, { content: "Café au lait" })
    expect(search("cafe")).toEqual([typed.versionId]) // diacritics folded
    expect(search("lai*")).toEqual([typed.versionId]) // prefix queries
    run(`UPDATE versions SET content = 'Black coffee' WHERE id = ?`, typed.versionId)
    expect(search("cafe")).toEqual([])
    expect(search("coffee")).toEqual([typed.versionId])
  })

  it("survives VACUUM", () => {
    const c = chat(user())
    const a = slot(c, null, { content: "harbor bell" })
    slot(c, a, { content: "slate roofs" })
    db.exec("VACUUM")
    expect(search("bell")).toEqual([a.versionId])
    db.exec(`INSERT INTO versions_fts (versions_fts) VALUES ('integrity-check')`)
  })
})
