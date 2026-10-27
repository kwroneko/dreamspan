// 0049: card modules become card notes, and a card's first note says it's on in every chat
// (DESIGN §4.1, §5.0). Synthetic cards and notes only.
import { assert, it } from "@effect/vitest"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { notesMigration } from "../src/db/notesMigration.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"

const note = (card: string, title: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  title,
  content: `${title} text.`,
  placement: { mode: "depth", depth: 4, role: "system" },
  owner: { card },
  exportable: true,
  ...fields
})

it.effect("0049 makes modules card notes and keeps the first note on, once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0049"))
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previous) })
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
    const insert = (
      entity: string,
      kind: string,
      revision: string,
      doc: Record<string, unknown>,
      ref = `r-${entity}`
    ) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO entities(id,owner_user_id,kind,created_at) VALUES(${entity},'u',${kind},1)`
        yield* sql`INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,search_text,created_at)
          VALUES(${revision},${entity},${JSON.stringify(doc)},${docHash(doc)},1,'import',${searchText(doc)},1)`
        yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,label,subtitle,created_at,updated_at)
          VALUES(${ref},${entity},'upstream',${revision},${entity},'',1,1)`
      })
    const placed = { mode: "section", section: "tail_end", role: "user" }
    const modules = [
      { id: "outfit", title: "Outfit", content: "A green coat.", exportable: true, placement: placed },
      { id: "secret", title: "Secret", content: "Fears boats.", exportable: false, agent_editable: true }
    ]
    yield* insert("card-a", "card", "card-a-1", { ...cardDoc("Aria"), modules })
    // A variant whose head has one more module, and the first one again.
    const variantDoc = {
      ...cardDoc("Aria"),
      modules: [...modules.slice(0, 1), { id: "storm", title: "Storm", content: "Thunder.", exportable: true }]
    }
    yield* sql`INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,search_text,created_at)
      VALUES('card-a-2','card-a','["card-a-1"]',${JSON.stringify(variantDoc)},${docHash(variantDoc)},1,'user',${searchText(variantDoc)},2)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,label,subtitle,created_at,updated_at)
      VALUES('variant','card-a','variant','card-a-2','r-card-a','card-a-1','Aria','Variant',1,1)`
    yield* insert("card-b", "card", "card-b-1", cardDoc("Bram"))
    // A card with modules and no note: its notes made from them stay off on a second run.
    yield* insert("card-c", "card", "card-c-1", { ...cardDoc("Cato"), modules: [{ ...modules[0]!, id: "cloak" }] })
    // Aria's first and second notes; Bram's, already on in every chat; a chat's own note.
    yield* insert("note-1", "note", "note-1-1", note("card-a", "Character's Note"))
    yield* insert("note-2", "note", "note-2-1", note("card-a", "Mood"))
    yield* insert("note-3", "note", "note-3-1", note("card-b", "Limp", { on_by_default: true }))
    yield* insert("note-4", "note", "note-4-1", { ...note("card-a", "Scene"), owner: { chat: "chat" } })
    const before = yield* sql<{ id: string; doc_json: string }>`SELECT id, doc_json FROM entity_revisions ORDER BY seq`

    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    // Old revisions keep their documents: the card its modules, the notes no switch.
    for (const row of before)
      assert.deepStrictEqual(
        (yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${row.id}`)[0],
        { doc_json: row.doc_json }
      )
    const head = (ref: string) =>
      Effect.map(
        sql<{ head: string; doc_json: string; parents: string }>`
          SELECT r.head_revision_id AS head, v.doc_json, v.parents FROM entity_refs r
          JOIN entity_revisions v ON v.id = r.head_revision_id WHERE r.id = ${ref}`,
        ([row]) => ({ ...row!, doc: JSON.parse(row!.doc_json) as Record<string, unknown> })
      )
    const first = yield* head("r-note-1")
    assert.strictEqual(first.doc.on_by_default, true)
    assert.deepStrictEqual(JSON.parse(first.parents), ["note-1-1"])
    for (const ref of ["r-note-2", "r-note-3", "r-note-4"]) {
      const unchanged = yield* head(ref)
      assert.strictEqual(unchanged.head, `${ref.slice(2)}-1`)
    }
    // Each module once, by its id, from every head of the card: off in chats, private kept.
    const made = yield* sql<{ doc_json: string; label: string }>`
      SELECT v.doc_json, r.label FROM entity_refs r JOIN entity_revisions v ON v.id = r.head_revision_id
      JOIN entities e ON e.id = r.entity_id
      WHERE e.kind = 'note' AND json_extract(v.doc_json, '$.module_id') IS NOT NULL
      ORDER BY json_extract(v.doc_json, '$.module_id')`
    assert.deepStrictEqual(
      made.map((row) => ({ label: row.label, doc: JSON.parse(row.doc_json) })),
      [
        {
          label: "Outfit",
          doc: {
            schema_version: 1,
            title: "Outfit",
            content: "A green coat.",
            placement: placed,
            owner: { card: "card-c" },
            exportable: true,
            module_id: "cloak"
          }
        },
        {
          label: "Outfit",
          doc: {
            schema_version: 1,
            title: "Outfit",
            content: "A green coat.",
            placement: placed,
            owner: { card: "card-a" },
            exportable: true,
            module_id: "outfit"
          }
        },
        {
          label: "Secret",
          doc: {
            schema_version: 1,
            title: "Secret",
            content: "Fears boats.",
            placement: { mode: "section", section: "after_main_prompt", role: "system" },
            owner: { card: "card-a" },
            exportable: false,
            agent_editable: true,
            module_id: "secret"
          }
        },
        {
          label: "Storm",
          doc: {
            schema_version: 1,
            title: "Storm",
            content: "Thunder.",
            placement: { mode: "section", section: "after_main_prompt", role: "system" },
            owner: { card: "card-a" },
            exportable: true,
            module_id: "storm"
          }
        }
      ]
    )
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])

    // Run again, it changes nothing.
    const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entity_revisions`
    yield* notesMigration
    assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM entity_revisions`, [{ n: count!.n }])
    assert.deepStrictEqual(
      yield* sql`SELECT count(*) AS n FROM entity_revisions WHERE json_extract(doc_json, '$.on_by_default') = 1`,
      [{ n: 2 }]
    )
  }).pipe(Effect.provide(writerConnection(join(tempDir("notes-migration"), "db.sqlite"))))
)
