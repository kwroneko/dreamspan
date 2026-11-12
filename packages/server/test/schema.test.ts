// Invariants the schema enforces by itself (DATA-MODEL.md §15), tested on a bare
// connection so no application code is involved.
import { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, it } from "vitest"
import { baseline } from "../src/db/baseline.ts"

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
  tx(() => {
    run(
      `INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (?, ?, 'rp', ?, ?)`,
      chatId,
      ownerId,
      status,
      now()
    )
  })
  return { chatId }
}

const versionSql = `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'verbatim', ?, ?, ?)`

/** Appends a slot with one version: the version first, then the slot (deferred keys). */
const slot = (
  c: { chatId: string },
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
      `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      slotId,
      c.chatId,
      parent?.slotId ?? null,
      depth,
      versionId,
      now()
    )
  })
  return { slotId, versionId, depth }
}

describe("version payload separation", () => {
  it("keeps every unbounded text/JSON field outside metadata and flag query plans", () => {
    const columns = all<{ name: string }>("PRAGMA table_info(versions)").map((c) => c.name)
    for (const column of [
      "content",
      "reasoning",
      "raw_content",
      "raw_reasoning",
      "raw_sections",
      "reply_sections",
      "rewrite_json",
      "frozen_macros",
      "cast_json",
      "direction",
      "error_json",
      "usage_json",
      "recorded_model_json",
      "recorded_generation_json",
      "context_form",
      "display_form",
      "greeting_ref"
    ])
      expect(columns).not.toContain(column)
    const c = chat(user())
    const s = slot(c, null, { content: "Synthetic long reply. ".repeat(1000) })
    expect(get<{ n: number }>("SELECT count(*) AS n FROM version_texts").n).toBe(1)
    const plan = all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT v.deleted_at, v.purged_at, v.fork_id, v.hidden
      FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ?`,
      c.chatId
    )
    expect(plan.some((r) => /version_texts/.test(r.detail))).toBe(false)
    expect(get<{ content: string }>("SELECT content FROM version_records WHERE id = ?", s.versionId).content).toBe(
      "Synthetic long reply. ".repeat(1000)
    )
  })

  it("guards payload ownership, retains empty payloads and cascades them with their version", () => {
    const c = chat(user())
    const s = slot(c, null)
    const seq = get<{ seq: number }>("SELECT seq FROM versions WHERE id = ?", s.versionId).seq
    expect(get<{ content: string }>("SELECT content FROM version_texts WHERE version_seq = ?", seq).content).toBe("")
    expect(() => run("DELETE FROM version_texts WHERE version_seq = ?", seq)).toThrow(/delete the version/)
    expect(() => run("UPDATE version_texts SET version_seq = version_seq + 1 WHERE version_seq = ?", seq)).toThrow(
      /never changes owner/
    )
    run("DELETE FROM chats WHERE id = ?", c.chatId)
    expect(get<{ n: number }>("SELECT count(*) AS n FROM version_texts").n).toBe(0)
  })

  it("requires exactly one payload at commit even for direct metadata inserts", () => {
    const c = chat(user())
    const s = slot(c, null)
    expect(() =>
      tx(() =>
        run(
          `INSERT INTO versions(id, slot_id, ordinal, status, writer, macro_mode, origin, created_at, updated_at)
      VALUES ('no-payload', ?, 1, 'complete', 'human', 'verbatim', 'user_written', 1, 1)`,
          s.slotId
        )
      )
    ).toThrow(/FOREIGN KEY/)
    expect(get<{ n: number }>("SELECT count(*) AS n FROM versions").n).toBe(1)
  })

  it("maintains SQLite character counts for freshness and eligibility without reading prose", () => {
    const c = chat(user())
    const s = slot(c, null, { content: "A🌙" })
    expect(
      get<{ content_length: number }>("SELECT content_length FROM versions WHERE id = ?", s.versionId).content_length
    ).toBe(2)
    expect(() => run("UPDATE versions SET content_length = 100 WHERE id = ?", s.versionId)).toThrow(
      /comes from its payload/
    )
    run("UPDATE version_records SET content = '' WHERE id = ?", s.versionId)
    expect(
      get<{ content_length: number }>("SELECT content_length FROM versions WHERE id = ?", s.versionId).content_length
    ).toBe(0)
  })

  it("freezes content on the payload table and requires a failed version's error", () => {
    const c = chat(user())
    const s = slot(c, null, { writer: "model", status: "generating" })
    const seq = get<{ seq: number }>("SELECT seq FROM versions WHERE id = ?", s.versionId).seq
    expect(() => run("UPDATE versions SET status = 'failed' WHERE id = ?", s.versionId)).toThrow(/require an error/)
    run(
      `UPDATE version_records SET content = 'partial', status = 'failed', error_json = '{"message":"Synthetic failure"}'
      WHERE id = ?`,
      s.versionId
    )
    expect(() => run("UPDATE version_texts SET content = 'replacement' WHERE version_seq = ?", seq)).toThrow(
      /immutable once generated/
    )
    expect(() => run("UPDATE version_texts SET error_json = NULL WHERE version_seq = ?", seq)).toThrow(
      /require an error/
    )
    expect(get<{ content: string }>("SELECT content FROM version_records WHERE id = ?", s.versionId).content).toBe(
      "partial"
    )
  })
})

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
  for (const statement of baseline) db.exec(statement)
})

describe("card forks", () => {
  const entity = (id: string, owner: string, kind = "card") => {
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (?, ?, ?, 1)`, id, owner, kind)
    run(
      `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
       VALUES (?, ?, '{}', 'h', 1, 'user', 1)`,
      `${id}-rev`,
      id
    )
  }
  const fork = (id: string, owner: string, parent: string | null, revision: string | null, chatId: string | null) =>
    run(
      `INSERT INTO entities (id, owner_user_id, kind, created_at, forked_from_entity_id, forked_from_revision_id, forked_in_chat_id, forked_at)
       VALUES (?, ?, 'card', 1, ?, ?, ?, 1)`,
      id,
      owner,
      parent,
      revision,
      chatId
    )
  const setParent = (id: string, parent: string | null) =>
    run(`UPDATE entities SET forked_from_entity_id = ? WHERE id = ?`, parent, id)

  it("keeps a fork's parent another entity of the same owner and kind", () => {
    const ana = user()
    const bob = user()
    entity("mira", ana)
    entity("theirs", bob)
    entity("note", ana, "note")
    expect(() => fork("f1", ana, "theirs", null, null)).toThrow(/a fork's parent/)
    expect(() => fork("f2", ana, "note", null, null)).toThrow(/a fork's parent/)
    expect(() => fork("f3", ana, "f3", null, null)).toThrow(/a fork's parent/)
    fork("f4", ana, "mira", "mira-rev", null)
    expect(() => setParent("f4", "theirs")).toThrow(/a fork's parent/)
    expect(() => setParent("f4", "note")).toThrow(/a fork's parent/)
    expect(() => setParent("f4", "f4")).toThrow(/a fork's parent/)
    expect(() => run(`UPDATE entities SET kind = 'note' WHERE id = 'f4'`)).toThrow(/a fork's parent/)
  })

  it("keeps the revision copied the parent's, and the chat made for the owner's", () => {
    const ana = user()
    const bob = user()
    entity("mira", ana)
    entity("ana", ana)
    const theirs = chat(bob)
    expect(() => fork("f1", ana, "mira", "ana-rev", null)).toThrow(/a fork's parent/)
    expect(() => fork("f2", ana, null, "mira-rev", null)).toThrow(/a fork's parent/)
    expect(() => fork("f3", ana, "mira", null, theirs.chatId)).toThrow(/a fork's parent/)
    fork("f4", ana, "mira", "mira-rev", null)
    expect(() => run(`UPDATE entities SET forked_from_revision_id = 'ana-rev' WHERE id = 'f4'`)).toThrow(
      /a fork's parent/
    )
    expect(() => run(`UPDATE entities SET forked_in_chat_id = ? WHERE id = 'f4'`, theirs.chatId)).toThrow(
      /a fork's parent/
    )
  })

  it("keeps the fork when its parent's revisions or its chat are deleted for good", () => {
    const ana = user()
    entity("mira", ana)
    const own = chat(ana)
    fork("f1", ana, "mira", "mira-rev", own.chatId)
    run(`DELETE FROM entity_revisions WHERE entity_id = 'mira'`)
    tx(() => run(`DELETE FROM chats WHERE id = ?`, own.chatId))
    expect(
      get(`SELECT forked_from_entity_id AS parent, forked_from_revision_id AS revision, forked_in_chat_id AS chat
           FROM entities WHERE id = 'f1'`)
    ).toEqual({ parent: "mira", revision: null, chat: null })
  })
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
      /keeps the selection it was inserted with/
    )
  })

  it("keeps a chat's active leaf inside the chat", () => {
    const owner = user()
    const a = chat(owner)
    const b = chat(owner)
    const s = slot(b, null)
    expect(() => run(`UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?`, s.slotId, a.chatId)).toThrow(
      /active leaf/
    )
    expect(() =>
      run(
        `INSERT INTO chats (id, owner_user_id, kind, status, active_leaf_slot_id, created_at) VALUES ('c-new', ?, 'rp', 'active', ?, 1)`,
        owner,
        s.slotId
      )
    ).toThrow(/active leaf/)
  })

  it("takes a version's source only from its own slot, and lets the source go", () => {
    const owner = user()
    const theirs = slot(chat(user()), null, { content: "theirs" })
    const s = slot(chat(owner), null, { writer: "model", content: "generated" })
    const edit = (source: string) =>
      run(
        `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, source_version_id, created_at, updated_at)
         VALUES (?, ?, 1, 'complete', 'human', 'edited', 'verbatim', 'edited', ?, 1, 1)`,
        id("v"),
        s.slotId,
        source
      )
    expect(() => edit(theirs.versionId)).toThrow(/source/)
    edit(s.versionId)
    expect(() =>
      run(`UPDATE versions SET source_version_id = ? WHERE ordinal = 1 AND slot_id = ?`, theirs.versionId, s.slotId)
    ).toThrow(/source/)
    // Deleting the source clears the reference instead of failing on it.
    const third = addVersion(s.slotId, 2, { writer: "model", content: "a swipe" })
    run(
      `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, source_version_id, created_at, updated_at)
       VALUES (?, ?, 3, 'complete', 'human', 'edited swipe', 'verbatim', 'edited', ?, 1, 1)`,
      id("v"),
      s.slotId,
      third
    )
    tx(() => run(`DELETE FROM versions WHERE id = ?`, third))
    expect(get(`SELECT source_version_id FROM versions WHERE slot_id = ? AND ordinal = 3`, s.slotId)).toEqual({
      source_version_id: null
    })
  })
})

describe("edits are non-destructive (invariant 1)", () => {
  it("freezes model output once generation ends", () => {
    const owner = user()
    const c = chat(owner)
    const s = slot(c, null, { writer: "model", status: "generating", content: "" })
    run(`UPDATE version_records SET content = 'partial text' WHERE id = ?`, s.versionId) // streaming is fine
    run(`UPDATE version_records SET content = 'full text', status = 'complete' WHERE id = ?`, s.versionId)
    expect(() => run(`UPDATE version_records SET content = 'rewritten' WHERE id = ?`, s.versionId)).toThrow(
      /immutable once generated/
    )
    // Generation doesn't reopen, for model or user-written versions.
    const typed = slot(c, s, { content: "typed" })
    for (const v of [s.versionId, typed.versionId]) {
      expect(() => run(`UPDATE versions SET status = 'generating' WHERE id = ?`, v)).toThrow(/never goes back/)
    }
    // Only deleting for good from the recycle bin empties model output.
    expect(() => run(`UPDATE version_records SET purged_at = 1, content = '' WHERE id = ?`, s.versionId)).toThrow(
      /immutable once generated/
    )
    const binItem = (userId: string, kind: string, targetId: string, chatId: string) => {
      const itemId = id("b")
      run(
        `INSERT INTO bin_items (id, user_id, kind, target_id, chat_id, title, excerpt, origin_json, byte_size, deleted_at)
           VALUES (?, ?, ?, ?, ?, '', '', '{}', 0, 1)`,
        itemId,
        userId,
        kind,
        targetId,
        chatId
      )
      return itemId
    }
    const purge = () => run(`UPDATE version_records SET purged_at = 1, content = '' WHERE id = ?`, s.versionId)
    // Pointing the version at a bin item that isn't its own doesn't open it up: another
    // user's item.
    const stranger = user()
    const strangers = chat(stranger)
    for (const item of [binItem(stranger, "version", s.versionId, strangers.chatId)]) {
      run(`UPDATE versions SET bin_item_id = ? WHERE id = ?`, item, s.versionId)
      run(`UPDATE slots SET bin_item_id = ? WHERE id = ?`, item, s.slotId)
      expect(purge).toThrow(/immutable once generated/)
    }
    run(`DROP TRIGGER IF EXISTS slots_deletion_per_fork`)
    run(
      `UPDATE slots SET deleted_at = 1, bin_item_id = ? WHERE id = ?`,
      binItem(owner, "message", s.slotId, c.chatId),
      s.slotId
    )
    purge()
    // Deleted for good stays deleted.
    expect(() => run(`UPDATE versions SET purged_at = NULL WHERE id = ?`, s.versionId)).toThrow(/stays purged/)
    run(`UPDATE slots SET purged_at = 1 WHERE id = ?`, s.slotId)
    expect(() => run(`UPDATE slots SET purged_at = NULL WHERE id = ?`, s.slotId)).toThrow(/stays purged/)
  })

  it("keeps the earlier content of an amended user-written version", () => {
    const c = chat(user())
    const s = slot(c, null, { content: "first draft" })
    run(`UPDATE version_records SET content = 'second draft', updated_at = 2 WHERE id = ?`, s.versionId)
    run(`UPDATE version_records SET content = 'final', updated_at = 3 WHERE id = ?`, s.versionId)
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
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('card', ?, 'preset', 1)`, owner)
    run(`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
         VALUES ('rev', 'card', '{}', 'h', 1, 'user', 1)`)
    run(`INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
         VALUES ('base', 'card', 'rev', 'Card', 1, 1)`)
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
    for (const table of ["slots", "versions", "state_events", "drafts"]) {
      expect(get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n).toBe(0)
    }
    expect(all<{ id: string }>(`SELECT id FROM entity_refs`).map((r) => r.id)).toEqual(["base"])
  })

  it("gives every entity one ref: a fork is an entity of its own (spec/LIBRARY-FORKS.md)", () => {
    const owner = user()
    for (const kind of ["card", "preset"]) {
      run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (?, ?, ?, 1)`, kind, owner, kind)
      run(
        `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
        VALUES (?, ?, '{}', 'h', 1, 'user', 1)`,
        `${kind}-rev`,
        kind
      )
      run(
        `INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
        VALUES (?, ?, ?, 'Entry', 1, 1)`,
        `${kind}-ref`,
        kind,
        `${kind}-rev`
      )
      expect(() =>
        run(
          `INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
          VALUES ('extra', ?, ?, 'Entry', 1, 1)`,
          kind,
          `${kind}-rev`
        )
      ).toThrow(/UNIQUE/)
    }
    expect(() => run(`UPDATE entity_refs SET entity_id = 'card' WHERE id = 'preset-ref'`)).toThrow()
  })

  it("never changes an entity revision", () => {
    const owner = user()
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('e1', ?, 'card', 1)`, owner)
    run(`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
         VALUES ('r1', 'e1', '{"name":"Mira"}', 'h1', 1, 'import', 1)`)
    expect(() => run(`UPDATE entity_revisions SET doc_json = '{}' WHERE id = 'r1'`)).toThrow(/immutable/)
  })

  it("has no unused thread tables or slot labels", () => {
    expect(all("SELECT name FROM sqlite_master WHERE name IN ('lanes', 'slot_parents')")).toEqual([])
    const columns = (table: string) => all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name)
    expect(columns("chats")).not.toContain("current_leaf_slot_id")
    for (const name of ["lane_id", "placement_group_id", "branch_name", "branch_name_user"])
      expect(columns("slots")).not.toContain(name)
  })

  it("makes every application table STRICT", () => {
    const tables = all<{ name: string; type: string; strict: number }>("PRAGMA table_list")
    expect(tables.filter((t) => t.type === "table" && !t.name.startsWith("sqlite_") && t.strict !== 1)).toEqual([])
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

describe("references across chats", () => {
  it("are refused from rollouts, summaries, jobs and changesets, so they can't block a chat's deletion", () => {
    const ours = chat(user())
    const victim = chat(user())
    const mine = slot(ours, null)
    const theirs = slot(victim, null)
    const rollout = (chatId: string, slotId: string | null, leafSlotId: string | null = null) => {
      const rolloutId = id("ro")
      run(
        `INSERT INTO rollouts (id, chat_id, kind, status, slot_id, leaf_slot_id, role, request_class, created_at, updated_at)
           VALUES (?, ?, 'generation', 'running', ?, ?, 'narrator', 'interactive', 1, 1)`,
        rolloutId,
        chatId,
        slotId,
        leafSlotId
      )
      return rolloutId
    }
    expect(() => rollout(ours.chatId, theirs.slotId)).toThrow(/same chat/)
    expect(() => rollout(ours.chatId, mine.slotId, theirs.slotId)).toThrow(/same chat/)
    const own = rollout(ours.chatId, mine.slotId, mine.slotId)
    expect(() => run(`UPDATE rollouts SET leaf_slot_id = ? WHERE id = ?`, theirs.slotId, own)).toThrow(/same chat/)
    expect(() => run(`UPDATE rollouts SET chat_id = ? WHERE id = ?`, victim.chatId, own)).toThrow(/another chat/)
    expect(() => run(`UPDATE versions SET rollout_id = ? WHERE id = ?`, own, theirs.versionId)).toThrow(/same chat/)

    const summary = (first: string, last: string) => {
      const summaryId = id("sum")
      tx(() => {
        const revisionId = id("sr")
        run(
          `INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at) VALUES (?, ?, 't', 1, 'generated', 1)`,
          revisionId,
          summaryId
        )
        run(
          `INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, created_at)
             VALUES (?, ?, 1, ?, ?, ?, 1, 1)`,
          summaryId,
          ours.chatId,
          revisionId,
          first,
          last
        )
      })
      return summaryId
    }
    expect(() => summary(theirs.slotId, mine.slotId)).toThrow(/same chat|declared primary-parent chain/)
    expect(() => summary(mine.slotId, theirs.slotId)).toThrow(/same chat|declared primary-parent chain/)
    const summaryId = summary(mine.slotId, mine.slotId)
    const input = (slotId: string, versionId: string) =>
      run(
        `INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id) VALUES (?, 0, ?, ?)`,
        summaryId,
        slotId,
        versionId
      )
    expect(() => run(`UPDATE summaries SET chat_id = ? WHERE id = ?`, victim.chatId, summaryId)).toThrow(
      /another chat|only summary/
    )
    expect(() => input(theirs.slotId, theirs.versionId)).toThrow(/same chat|declared chain in order/)
    expect(() => input(mine.slotId, theirs.versionId)).toThrow(/in its slot/)
    input(mine.slotId, mine.versionId)
    expect(() =>
      run(
        `INSERT INTO summarization_jobs (id, chat_id, level, first_slot_id, last_slot_id, target_token_count, created_at, updated_at)
           VALUES ('job', ?, 1, ?, ?, 100, 1, 1)`,
        ours.chatId,
        theirs.slotId,
        theirs.slotId
      )
    ).toThrow(/same chat/)

    // The victim can still delete their chat.
    tx(() => run(`DELETE FROM chats WHERE id = ?`, victim.chatId))
  })

  it("never moves a row others refer to into another chat", () => {
    const ana = user()
    const ours = chat(ana)
    const victim = chat(user())
    const s = slot(ours, null, { writer: "model" })
    run(
      `INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at)
         VALUES ('ro', ?, 'generation', 'running', 'narrator', 'interactive', 1, 1)`,
      ours.chatId
    )
    run(`INSERT INTO forks(id,chat_id,created_at) VALUES ('cs-fork',?,1)`, ours.chatId)
    run(
      `INSERT INTO changeset_groups(id,owner_user_id,title,origin,created_at) VALUES ('cs-group',?,'Edit','user',1)`,
      ana
    )
    run(
      `INSERT INTO changesets (id, chat_id, fork_id, seq, group_id, title, origin, status, created_at) VALUES ('cs', ?, 'cs-fork', 1, 'cs-group', 'Edit', 'user', 'applied', 1)`,
      ours.chatId
    )
    run(`UPDATE versions SET rollout_id = 'ro', changeset_id = 'cs' WHERE id = ?`, s.versionId)
    run(
      `INSERT INTO summarization_jobs (id, chat_id, level, first_slot_id, last_slot_id, target_token_count, created_at, updated_at)
         VALUES ('job', ?, 1, ?, ?, 100, 1, 1)`,
      ours.chatId,
      s.slotId,
      s.slotId
    )
    run(
      `INSERT INTO bin_items (id, user_id, kind, target_id, chat_id, title, excerpt, origin_json, byte_size, deleted_at)
         VALUES ('item', ?, 'message', ?, ?, '', '', '{}', 0, 1)`,
      ana,
      s.slotId,
      ours.chatId
    )
    for (const [table, rowId] of [
      ["rollouts", "ro"],
      ["changesets", "cs"],
      ["summarization_jobs", "job"],
      ["bin_items", "item"]
    ] as const) {
      expect(() => run(`UPDATE ${table} SET chat_id = ? WHERE id = ?`, victim.chatId, rowId), table).toThrow(
        /another chat/
      )
    }
    tx(() => run(`DELETE FROM chats WHERE id = ?`, victim.chatId))
  })

  it("never hands a chat, card or connection to another user", () => {
    const owner = user()
    const stranger = user()
    const c = chat(owner)
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('card', ?, 'card', 1)`, owner)
    run(
      `INSERT INTO connections (id, owner_user_id, name, provider, kind, api, created_at, updated_at)
         VALUES ('conn', ?, 'Local', 'openai-compatible', 'openai-chat', 'openai-completions', 1, 1)`,
      owner
    )
    for (const [table, rowId] of [
      ["chats", c.chatId],
      ["entities", "card"],
      ["connections", "conn"]
    ] as const) {
      expect(() => run(`UPDATE ${table} SET owner_user_id = ? WHERE id = ?`, stranger, rowId), table).toThrow(
        /never change owner/
      )
    }
  })

  it("never hands a key, session, draft or bin item to another user, nor a ref to another entity", () => {
    const owner = user()
    const stranger = user()
    run(
      `INSERT INTO credentials (id, owner_user_id, name, key_enc, key_hint, created_at, updated_at)
         VALUES ('cred', ?, 'Key', x'00', '', 1, 1)`,
      owner
    )
    run(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('t', ?, 1, 2)`, owner)
    const c = chat(owner)
    run(
      `INSERT INTO bin_items (id, user_id, kind, target_id, chat_id, title, excerpt, origin_json, byte_size, deleted_at)
         VALUES ('bin', ?, 'chat', ?, NULL, 'Chat', '', '{}', 0, 1)`,
      owner,
      c.chatId
    )
    for (const [table, column, key, rowId] of [
      ["credentials", "owner_user_id", "id", "cred"],
      ["sessions", "user_id", "token_hash", "t"],
      ["bin_items", "user_id", "id", "bin"]
    ] as const) {
      expect(() => run(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`, stranger, rowId), table).toThrow(
        /never change owner/
      )
    }
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('mine', ?, 'card', 1)`, owner)
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES ('theirs', ?, 'card', 1)`, stranger)
    run(`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
         VALUES ('rev', 'mine', '{}', 'h', 1, 'user', 1)`)
    run(`INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
         VALUES ('ref', 'mine', 'rev', 'Mine', 1, 1)`)
    expect(() => run(`UPDATE entity_refs SET entity_id = 'theirs' WHERE id = 'ref'`)).toThrow(
      /never moves to another entity/
    )
  })
})

describe("summaries", () => {
  it("select only their own revisions", () => {
    const c = chat(user())
    const s = slot(c, null)
    const summary = (summaryId: string, revisionOf: string) =>
      tx(() => {
        const revisionId = id("sr")
        run(
          `INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at) VALUES (?, ?, 'text', 1, 'generated', 1)`,
          revisionId,
          revisionOf
        )
        run(
          `INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, created_at)
           VALUES (?, ?, 1, ?, ?, ?, 1, 1)`,
          summaryId,
          c.chatId,
          revisionId,
          s.slotId,
          s.slotId
        )
      })
    summary("sum1", "sum1")
    expect(() => summary("sum2", "sum1")).toThrow(/own revisions/)
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

describe("the send queue", () => {
  const insert = `INSERT INTO queued_messages (id, chat_id, reply_slot_id, seq, kind, content, speaker_entity_id, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, 1, 1)`
  const entity = (ownerId: string) => {
    const entityId = id("e")
    run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (?, ?, 'card', 1)`, entityId, ownerId)
    return entityId
  }

  it("waits on a slot of its own chat, never moves, and speaks as the chat owner's card", () => {
    const owner = user()
    const other = user()
    const a = chat(owner)
    const b = chat(owner)
    const sa = slot(a, null)
    const sb = slot(b, null)
    const mine = entity(owner)
    const theirs = entity(other)
    expect(() => run(insert, id("q"), a.chatId, sb.slotId, "message", "hi", null)).toThrow(/same chat/)
    expect(() => run(insert, id("q"), a.chatId, sa.slotId, "message", "hi", theirs)).toThrow(/chat's owner/)
    const q = id("q")
    run(insert, q, a.chatId, sa.slotId, "message", "hi", mine)
    expect(() => run(`UPDATE queued_messages SET chat_id = ? WHERE id = ?`, b.chatId, q)).toThrow(/another chat/)
    expect(() => run(`UPDATE queued_messages SET reply_slot_id = ? WHERE id = ?`, sb.slotId, q)).toThrow(/same chat/)
    expect(() => run(`UPDATE queued_messages SET speaker_entity_id = ? WHERE id = ?`, theirs, q)).toThrow(
      /chat's owner/
    )
    expect(() => run(`UPDATE queued_messages SET reply_speaker_entity_id = ? WHERE id = ?`, theirs, q)).toThrow(
      /chat's owner/
    )
    run(`UPDATE queued_messages SET reply_speaker_entity_id = ? WHERE id = ?`, mine, q)
    // A message has text; only a reply asked for has a direction.
    expect(() => run(insert, id("q"), a.chatId, sa.slotId, "message", "", null)).toThrow(/CHECK/)
    run(insert, id("q"), a.chatId, sa.slotId, "generate", "", null)
  })

  it("goes with its chat or its slot", () => {
    const owner = user()
    const c = chat(owner)
    const s1 = slot(c, null)
    run(insert, id("q"), c.chatId, s1.slotId, "message", "hi", null)
    run(`DELETE FROM chats WHERE id = ?`, c.chatId)
    expect(get<{ n: number }>(`SELECT count(*) AS n FROM queued_messages`).n).toBe(0)
  })
})

describe("foreign keys", () => {
  // Rows of these tables are never deleted (entities and connections stay as tombstones).
  const neverDeleted = new Set(["users", "media_assets", "models", "entities", "connections"])
  // Found without an index when the chain was squashed; the baseline keeps the schema as it was.
  const unindexedOk = new Set(["lcm_enable_slots.version_id", "chat_pins.chat_id"])

  it("are indexed on the referencing side wherever the referenced row can be deleted", () => {
    const unindexed: Array<string> = []
    for (const { name } of all<{ name: string }>(`SELECT name FROM sqlite_schema WHERE type = 'table'`)) {
      const leading = new Set(
        all<{ name: string }>(`SELECT name FROM pragma_index_list(?)`, name).map(
          (index) => get<{ name: string }>(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, index.name).name
        )
      )
      // INTEGER PRIMARY KEY aliases rowid and has no separate pragma_index_list entry.
      const primary = all<{ name: string; type: string }>(
        `SELECT name, type FROM pragma_table_info(?) WHERE pk > 0`,
        name
      )
      if (primary.length === 1 && primary[0]!.type === "INTEGER") leading.add(primary[0]!.name)
      for (const fk of all<{ from: string; table: string }>(`SELECT * FROM pragma_foreign_key_list(?)`, name)) {
        if (!neverDeleted.has(fk.table) && !leading.has(fk.from) && !unindexedOk.has(`${name}.${fk.from}`))
          unindexed.push(`${name}.${fk.from}`)
      }
    }
    expect(unindexed).toEqual([])
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
    run(`UPDATE version_records SET content = 'the lantern swung low' WHERE id = ?`, streaming.versionId)
    expect(search("lantern")).toEqual([])
    run(`UPDATE versions SET status = 'complete' WHERE id = ?`, streaming.versionId)
    expect(search("lantern")).toEqual([streaming.versionId])

    const typed = slot(c, streaming, { content: "Café au lait" })
    expect(search("cafe")).toEqual([typed.versionId]) // diacritics folded
    expect(search("lai*")).toEqual([typed.versionId]) // prefix queries
    run(`UPDATE version_records SET content = 'Black coffee' WHERE id = ?`, typed.versionId)
    expect(search("cafe")).toEqual([])
    expect(search("coffee")).toEqual([typed.versionId])
  })

  it("forgets deleted text, even when a later row reuses its seq", () => {
    const ana = user()
    const bob = user()
    const revision = (owner: string, text: string) => {
      const entityId = id("e")
      run(`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (?, ?, 'card', 1)`, entityId, owner)
      run(
        `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, search_text, created_at)
         VALUES (?, ?, '{}', 'h', 1, 'user', ?, 1)`,
        id("r"),
        entityId,
        text
      )
      return entityId
    }
    const matches = (q: string) =>
      all<{ owner: string }>(
        `SELECT e.owner_user_id AS owner FROM entity_revisions_fts f JOIN entity_revisions r ON r.seq = f.rowid
         JOIN entities e ON e.id = r.entity_id WHERE entity_revisions_fts MATCH ?`,
        q
      ).map((r) => r.owner)
    const purged = revision(ana, "a secret lighthouse")
    run(`DELETE FROM entity_revisions WHERE entity_id = ?`, purged)
    revision(bob, "an ordinary harbor") // takes the freed seq
    expect(matches("lighthouse")).toEqual([])
    expect(matches("harbor")).toEqual([bob])
  })

  it("removes version search terms before cascading the payload and reusing its integer key", () => {
    const oldChat = chat(user())
    const old = slot(oldChat, null, { writer: "model", content: "private lighthouse" })
    const seq = get<{ seq: number }>("SELECT seq FROM versions WHERE id = ?", old.versionId).seq
    run("DELETE FROM chats WHERE id = ?", oldChat.chatId)
    const fresh = slot(chat(user()), null, { writer: "model", content: "ordinary harbor" })
    expect(get<{ seq: number }>("SELECT seq FROM versions WHERE id = ?", fresh.versionId).seq).toBe(seq)
    const hits = (text: string) =>
      all<{ id: string }>(
        `SELECT v.id FROM versions_fts f
      JOIN versions v ON v.seq = f.rowid WHERE versions_fts MATCH ?`,
        text
      ).map((r) => r.id)
    expect(hits("lighthouse")).toEqual([])
    expect(hits("harbor")).toEqual([fresh.versionId])
  })

  it("keeps every index in step with inserts, updates and deletes of its table", () => {
    const tables = all<{ name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE % USING fts5%'`
    ).map((r) => r.name.replace(/_fts$/, ""))
    expect(tables.sort()).toEqual(["entity_revisions", "summary_revisions", "versions"])
    for (const table of tables) {
      const events = all<{ sql: string }>(
        `SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (?, ?) AND sql LIKE ?`,
        table,
        table === "versions" ? "version_texts" : table,
        `%${table}_fts%`
      ).map((r) => /(?:BEFORE|AFTER) (INSERT|UPDATE|DELETE)/.exec(r.sql)?.[1])
      const immutable = all(`SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?`, `${table}_immutable`)
      expect(new Set(events), table).toEqual(
        new Set(immutable.length ? ["INSERT", "DELETE"] : ["INSERT", "UPDATE", "DELETE"])
      )
    }
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

describe("connections and the usage ledger", () => {
  const connection = (ownerId: string) => {
    const connectionId = id("conn")
    run(
      `INSERT INTO connections (id, owner_user_id, name, provider, kind, api, created_at, updated_at)
         VALUES (?, ?, 'Local', 'openai-compatible', 'openai-chat', 'openai-completions', 1, 1)`,
      connectionId,
      ownerId
    )
    return connectionId
  }
  const model = (connectionId: string, key = "m") => {
    const modelId = id("model")
    run(
      `INSERT INTO models (id, connection_id, model_key, source, created_at) VALUES (?, ?, ?, 'fetched', 1)`,
      modelId,
      connectionId,
      key
    )
    return modelId
  }
  const request = (
    ownerId: string,
    connectionId: string,
    attribution: { modelId?: string; chatId?: string; versionId?: string } = {}
  ) => {
    const requestId = id("req")
    run(
      `INSERT INTO llm_requests (id, owner_user_id, connection_id, model_id, chat_id, version_id, purpose, api, provider, model_key, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'generation', 'openai-completions', 'openai', 'm', 'running', 1)`,
      requestId,
      ownerId,
      connectionId,
      attribution.modelId ?? null,
      attribution.chatId ?? null,
      attribution.versionId ?? null
    )
    return requestId
  }
  const close = (requestId: string) =>
    run(
      `UPDATE llm_requests SET status = 'complete', ended_at = 2, input_uncached = 10, cache_read = 90, output = 5,
         usage_source = 'reported', raw_usage_json = '{"prompt_tokens":100}' WHERE id = ?`,
      requestId
    )

  it("keeps a connection's secrets consistent", () => {
    const owner = user()
    const stranger = user()
    const conn = connection(owner)
    const credential = (ownerId: string) => {
      const credentialId = id("cred")
      run(
        `INSERT INTO credentials (id, owner_user_id, name, key_enc, key_hint, origins_json, created_at, updated_at)
           VALUES (?, ?, 'Key', x'00', 'abcd', '[]', 1, 1)`,
        credentialId,
        ownerId
      )
      return credentialId
    }
    // Keys live in credentials; the retired per-connection columns stay empty.
    expect(() => run(`UPDATE connections SET api_key_enc = x'00', key_hint = 'abcd' WHERE id = ?`, conn)).toThrow(
      /credentials/
    )
    // A connection uses only its owner's credentials.
    expect(() => run(`UPDATE connections SET credential_id = ? WHERE id = ?`, credential(stranger), conn)).toThrow(
      /owner's credentials/
    )
    const own = credential(owner)
    run(`UPDATE connections SET credential_id = ? WHERE id = ?`, own, conn)
    expect(() => run(`UPDATE connections SET proxy_mode = 'custom' WHERE id = ?`, conn)).toThrow(/CHECK/)
    // A purged connection keeps its row but none of its secrets.
    expect(() => run(`UPDATE connections SET purged_at = 3 WHERE id = ?`, conn)).toThrow(/credential/)
    run(`UPDATE connections SET purged_at = 3, credential_id = NULL WHERE id = ?`, conn)
    // Deleting a credential leaves the connections that used it without a key.
    const other = connection(owner)
    run(`UPDATE connections SET credential_id = ? WHERE id = ?`, own, other)
    run(`DELETE FROM credentials WHERE id = ?`, own)
    expect(get(`SELECT credential_id FROM connections WHERE id = ?`, other)).toEqual({ credential_id: null })
  })

  it("never moves a model to another connection", () => {
    const owner = user()
    const m = model(connection(owner))
    const other = connection(owner)
    expect(() => run(`UPDATE models SET connection_id = ? WHERE id = ?`, other, m)).toThrow(/never moves/)
    expect(() => run(`UPDATE models SET model_key = 'renamed' WHERE id = ?`, m)).toThrow(/never moves/)
  })

  it("attributes a request only to its own user's chat and its connection's models", () => {
    const owner = user()
    const stranger = user()
    const conn = connection(owner)
    const strangersChat = chat(stranger)
    expect(() => request(owner, conn, { chatId: strangersChat.chatId })).toThrow(/attributed/)
    expect(() => request(owner, conn, { modelId: model(connection(owner)) })).toThrow(/attributed/)
    const own = chat(owner)
    const otherChat = chat(owner)
    const s = slot(own, null, { writer: "model", status: "generating" })
    expect(() => request(owner, conn, { chatId: otherChat.chatId, versionId: s.versionId })).toThrow(/attributed/)
    const r = request(owner, conn, { modelId: model(conn), chatId: own.chatId, versionId: s.versionId })
    expect(() => run(`UPDATE llm_requests SET chat_id = ? WHERE id = ?`, otherChat.chatId, r)).toThrow(/cleared/)
  })

  it("is open until closed, and a closed request is a record", () => {
    const owner = user()
    const r = request(owner, connection(owner))
    expect(() => run(`UPDATE llm_requests SET status = 'complete' WHERE id = ?`, r)).toThrow(/CHECK/)
    close(r)
    expect(() => run(`UPDATE llm_requests SET output = 6 WHERE id = ?`, r)).toThrow(/record/)
    expect(() => run(`UPDATE llm_requests SET status = 'failed' WHERE id = ?`, r)).toThrow(/record/)
    // Only the cost can be recomputed, and it always names its formula.
    expect(() => run(`UPDATE llm_requests SET cost = 0.01 WHERE id = ?`, r)).toThrow(/CHECK/)
    run(`UPDATE llm_requests SET cost = 0.01, cost_currency = 'USD', cost_formula = 'builtin' WHERE id = ?`, r)
  })

  it("outlives a chat deleted for good", () => {
    const owner = user()
    const conn = connection(owner)
    const c = chat(owner)
    const s = slot(c, null, { writer: "model", status: "generating" })
    const r = request(owner, conn, { chatId: c.chatId, versionId: s.versionId })
    close(r)
    tx(() => run(`DELETE FROM chats WHERE id = ?`, c.chatId))
    expect(get(`SELECT chat_id, version_id, output FROM llm_requests WHERE id = ?`, r)).toEqual({
      chat_id: null,
      version_id: null,
      output: 5
    })
  })
})

describe("fork-scoped state events", () => {
  it("keeps event provenance paired, positive, immutable and inside its chat", () => {
    const owner = user()
    const c = chat(owner)
    const other = chat(owner)
    const insert = (eventId: string, fork: string | null, seq: number | null) =>
      run(
        `INSERT INTO state_events(id,chat_id,slot_id,seq,key,value_json,origin,created_at,fork_id,fork_seq)
       VALUES (?, ?, NULL, 0, 'var.set', '{"name":"x","value":1}', 'user', 1, ?, ?)`,
        eventId,
        c.chatId,
        fork,
        seq
      )
    expect(() => insert("bad-chat", other.chatId, 1)).toThrow(/fork of its chat/)
    expect(() => insert("no-seq", c.chatId, null)).toThrow(/CHECK/)
    expect(() => insert("no-fork", null, 1)).toThrow(/CHECK/)
    expect(() => insert("zero", c.chatId, 0)).toThrow(/CHECK/)
    insert("scoped", c.chatId, 1)
    expect(() => run("UPDATE state_events SET fork_seq = 2 WHERE id = 'scoped'")).toThrow(/immutable/)
    // It carries its fork's place in the fork tree, set when written and kept (db/forkLabels.ts).
    expect(() => run("UPDATE state_events SET fork_label = x'05' WHERE id = 'scoped'")).toThrow(/fork label/)
    expect(() =>
      run(
        `INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,flag)
      VALUES ('wrong-event', ?, ?, 1, 'suppress_event', 'missing', 1)`,
        c.chatId,
        c.chatId
      )
    ).toThrow(/suppression/)
  })

  it("stores card swaps without a message, version or scope, and with a fork", () => {
    const c = chat(user())
    const s = slot(c, null)
    const insert = (slotId: string | null, scope: string | null, forkId: string | null) =>
      run(
        `INSERT INTO state_events(id,chat_id,slot_id,seq,key,scope,value_json,origin,created_at,fork_id,fork_seq)
       VALUES (?, ?, ?, 0, 'card.swap', ?, '{}', 'user', 1, ?, ?)`,
        id("event"),
        c.chatId,
        slotId,
        scope,
        forkId,
        forkId === null ? null : 1
      )
    expect(() => insert(s.slotId, null, c.chatId)).toThrow(/CHECK/)
    expect(() => insert(null, "narrator", c.chatId)).toThrow(/CHECK/)
    expect(() => insert(null, null, null)).toThrow(/CHECK/)
    insert(null, null, c.chatId)
  })
})

describe("inserted messages (spec/MESSAGE-INSERT.md §2.2)", () => {
  /** A slot inserted below `anchor` (null: above the first message), with one version of `origin`. */
  const inserted = (c: { chatId: string }, anchor: { slotId: string; depth: number } | null) => {
    const slotId = id("x")
    const versionId = id("v")
    tx(() => {
      run(
        `INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
         VALUES (?, ?, 0, 'complete', 'model', 'copy', 'verbatim', 'duplicate', ?, ?)`,
        versionId,
        slotId,
        now(),
        now()
      )
      run(
        `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, inserted)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        slotId,
        c.chatId,
        anchor?.slotId ?? null,
        anchor === null ? 0 : anchor.depth + 1,
        versionId,
        now()
      )
    })
    return { slotId, versionId, depth: anchor === null ? 0 : anchor.depth + 1 }
  }
  const placeRow = (
    rowId: string,
    chatId: string,
    forkId: string,
    target: string,
    anchor: string | null,
    flag: number | null,
    extra: { valueId?: string } = {}
  ) =>
    run(
      `INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
       VALUES (?, ?, ?, ?, 'insert', ?, ?, (SELECT depth FROM slots WHERE id = ?), ?, ?)`,
      rowId,
      chatId,
      forkId,
      ++n,
      target,
      anchor,
      anchor,
      extra.valueId ?? null,
      flag
    )

  it("keeps a slot inserted or not as it was inserted", () => {
    const c = chat(user())
    const a = slot(c, null)
    const x = inserted(c, a)
    expect(get<{ inserted: number }>("SELECT inserted FROM slots WHERE id = ?", a.slotId).inserted).toBe(0)
    expect(() => run("UPDATE slots SET inserted = 1 WHERE id = ?", a.slotId)).toThrow(/stays inserted or not/)
    expect(() => run("UPDATE slots SET inserted = 0 WHERE id = ?", x.slotId)).toThrow(/stays inserted or not/)
    expect(() => run("UPDATE slots SET inserted = 2 WHERE id = ?", x.slotId)).toThrow(/stays inserted or not|CHECK/)
    run("UPDATE slots SET inserted = 1 WHERE id = ?", x.slotId) // unchanged
    // A duplicate's version keeps its origin like any other.
    expect(() => run("UPDATE versions SET origin = 'user_written' WHERE id = ?", x.versionId)).toThrow()
  })

  it("places only an inserted slot of the override's chat, below the anchor the row names", () => {
    const owner = user()
    const c = chat(owner)
    const other = chat(owner)
    const a = slot(c, null)
    const b = slot(c, a)
    const x = inserted(c, a)
    const top = inserted(c, null)
    const elsewhere = inserted(other, slot(other, null))
    const message = /an insertion places an inserted slot/
    expect(() => placeRow(id("o"), c.chatId, c.chatId, b.slotId, a.slotId, 1)).toThrow(message) // not inserted
    expect(() => placeRow(id("o"), c.chatId, c.chatId, x.slotId, b.slotId, 1)).toThrow(message) // anchor ≠ parent
    expect(() => placeRow(id("o"), c.chatId, c.chatId, x.slotId, null, 1)).toThrow(message)
    expect(() => placeRow(id("o"), c.chatId, c.chatId, top.slotId, a.slotId, 1)).toThrow(message)
    expect(() => placeRow(id("o"), c.chatId, c.chatId, elsewhere.slotId, null, 1)).toThrow(message) // another chat
    expect(() => placeRow(id("o"), c.chatId, c.chatId, x.slotId, a.slotId, null)).toThrow(message) // no flag
    expect(() => placeRow(id("o"), c.chatId, c.chatId, x.slotId, a.slotId, 1, { valueId: x.versionId })).toThrow(
      message
    )
    // The anchor's depth is the row's, as for every slot-keyed override.
    expect(() =>
      run(
        `INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, flag)
         VALUES (?, ?, ?, ?, 'insert', ?, ?, 5, 1)`,
        id("o"),
        c.chatId,
        c.chatId,
        ++n,
        x.slotId,
        a.slotId
      )
    ).toThrow(message)
    expect(() => placeRow(id("o"), other.chatId, other.chatId, x.slotId, a.slotId, 1)).toThrow(/fork's chat|insertion/)

    const placed = id("o")
    placeRow(placed, c.chatId, c.chatId, x.slotId, a.slotId, 1)
    placeRow(id("o"), c.chatId, c.chatId, top.slotId, null, 0)
    run("UPDATE fork_overrides SET flag = 0, seq = ? WHERE id = ?", ++n, placed)
    expect(() => run("UPDATE fork_overrides SET flag = NULL WHERE id = ?", placed)).toThrow(message)
    expect(() => run("UPDATE fork_overrides SET value_id = ? WHERE id = ?", x.versionId, placed)).toThrow(message)
    expect(() => run("UPDATE fork_overrides SET target_id = ? WHERE id = ?", top.slotId, placed)).toThrow(
      /keeps its fork, kind and target/
    )
    expect(() => run("UPDATE fork_overrides SET kind = 'hide' WHERE id = ?", placed)).toThrow(
      /keeps its fork, kind and target/
    )
  })
})

describe("library replace records", () => {
  it("enforces ownership, revision identity, positive counts and immutable unique membership", () => {
    const owner = user(),
      other = user()
    const make = (e: string, u: string) => {
      run("INSERT INTO entities(id,owner_user_id,kind,created_at) VALUES (?,?,'card',1)", e, u)
      for (const suffix of ["before", "after", "undo"])
        run(
          "INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,created_at) VALUES (?,?,'{}','h',1,'user',1)",
          e + suffix,
          e
        )
      run(
        "INSERT INTO entity_refs(id,entity_id,head_revision_id,label,created_at,updated_at) VALUES (?,?,?,'Card',1,1)",
        e + "ref",
        e,
        e + "after"
      )
    }
    make("mine", owner)
    make("theirs", other)
    for (const [g, u] of [
      ["own", owner],
      ["foreign", other]
    ])
      run(
        "INSERT INTO changeset_groups(id,owner_user_id,title,origin,created_at) VALUES (?,?,'Replace','user',1)",
        g!,
        u!
      )
    const insert = (
      group = "own",
      ref = "mineref",
      before = "minebefore",
      after = "mineafter",
      matches = 1,
      undo: string | null = null
    ) =>
      run(
        "INSERT INTO library_edit_items(group_id,ref_id,before_revision_id,after_revision_id,matches,undone_by_revision_id) VALUES (?,?,?,?,?,?)",
        group,
        ref,
        before,
        after,
        matches,
        undo
      )
    expect(() => insert("foreign")).toThrow()
    expect(() => insert("own", "mineref", "theirsbefore")).toThrow()
    expect(() => insert("own", "mineref", "minebefore", "theirsafter")).toThrow()
    expect(() => insert("own", "mineref", "minebefore", "mineafter", 0)).toThrow()
    expect(() => insert("own", "mineref", "minebefore", "mineafter", 1, "theirsundo")).toThrow()
    insert()
    expect(() => insert()).toThrow()
    for (const [column, value] of [
      ["group_id", "foreign"],
      ["ref_id", "theirsref"],
      ["before_revision_id", "theirsbefore"],
      ["after_revision_id", "theirsafter"],
      ["matches", 2]
    ])
      expect(() => run(`UPDATE library_edit_items SET ${column}=?`, value!)).toThrow()
    expect(() => run("UPDATE changeset_groups SET owner_user_id=? WHERE id='own'", other)).toThrow()
    expect(() => run("UPDATE library_edit_items SET undone_by_revision_id='theirsundo'")).toThrow()
    run("UPDATE library_edit_items SET undone_by_revision_id='mineundo'")
    run("DELETE FROM entity_revisions WHERE id='mineundo'")
    expect(get<{ u: string | null }>("SELECT undone_by_revision_id AS u FROM library_edit_items").u).toBeNull()
    run("DELETE FROM entity_refs WHERE id='mineref'")
    expect(all("SELECT * FROM library_edit_items")).toHaveLength(0)
  })
})
