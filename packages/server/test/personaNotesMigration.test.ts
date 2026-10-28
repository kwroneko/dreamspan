// 0050: a persona's description note becomes an ordinary note, and the persona card keeps one
// copy of the text (DESIGN §4.1, owner 2026-10-28). Synthetic cards and notes of every old kind.
import { assert, it } from "@effect/vitest"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { personaNotesMigration } from "../src/db/personaNotesMigration.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"

const note = (owner: Record<string, string>, title: string, fields: Record<string, unknown> = {}) => ({
  schema_version: 1,
  title,
  content: `${title} text.`,
  placement: { mode: "depth", depth: 4, role: "system" },
  owner,
  exportable: true,
  ...fields
})

it.effect("0050 makes persona description notes ordinary and keeps one copy of the text, once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0050"))
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previous) })
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
    const insert = (entity: string, kind: string, doc: Record<string, unknown>, deleted = false) =>
      Effect.gen(function* () {
        const revision = `${entity}-1`
        yield* sql`INSERT INTO entities(id,owner_user_id,kind,created_at,deleted_at)
          VALUES(${entity},'u',${kind},1,${deleted ? 2 : null})`
        yield* sql`INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,search_text,created_at)
          VALUES(${revision},${entity},${JSON.stringify(doc)},${docHash(doc)},1,'import',${searchText(doc)},1)`
        yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,label,subtitle,created_at,updated_at)
          VALUES(${`r-${entity}`},${entity},'upstream',${revision},${entity},'',1,1)`
      })
    const persona = (name: string, description: string) => ({ ...cardDoc(name), description })
    const atTop = { mode: "section", section: "author_note_top" }
    const description = (card: string, content: string, fields: Record<string, unknown> = {}) =>
      note({ card }, "Persona description", { content, on_by_default: true, ...fields })

    // Sam: the import's two copies, alike, at the top of the author's note; a variant too.
    yield* insert("card-sam", "card", persona("Sam", "Sam is curious."))
    yield* insert(
      "n1-sam",
      "note",
      description("card-sam", "Sam is curious.", { placement: atTop, kind: "persona_description" })
    )
    const variant = persona("Sam", "  Sam is curious.  ")
    yield* sql`INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,search_text,created_at)
      VALUES('card-sam-v','card-sam','["card-sam-1"]',${JSON.stringify(variant)},${docHash(variant)},1,'user',${searchText(variant)},2)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,label,subtitle,created_at,updated_at)
      VALUES('variant-sam','card-sam','variant','card-sam-v','r-card-sam','card-sam-1','Sam','Variant',1,1)`
    // Chat overrides of Sam's card (one edited, one alike) and of its note, in two chats.
    yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,created_at) VALUES('chat-1','u','rp','active',1),('chat-2','u','rp','active',1)`
    const edited = persona("Sam", "Sam is curious, and shy.")
    yield* sql`INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,search_text,created_at)
      VALUES('card-sam-e','card-sam','["card-sam-1"]',${JSON.stringify(edited)},${docHash(edited)},1,'user',${searchText(edited)},2)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,chat_id,label,subtitle,created_at,updated_at)
      VALUES('over-sam-1','card-sam','chat_override','card-sam-e','r-card-sam','card-sam-1','chat-1','Sam','',1,1),
        ('over-sam-2','card-sam','chat_override','card-sam-1','r-card-sam','card-sam-1','chat-2','Sam','',1,1)`
    const own = { ...description("card-sam", "Sam is curious, in this chat.", { kind: "persona_description" }) }
    yield* sql`INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,search_text,created_at)
      VALUES('n1-sam-o','n1-sam','["n1-sam-1"]',${JSON.stringify(own)},${docHash(own)},1,'user',${searchText(own)},2)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,chat_id,label,subtitle,created_at,updated_at)
      VALUES('over-n1-sam','n1-sam','chat_override','n1-sam-o','r-n1-sam','n1-sam-1','chat-1','n','',1,1)`
    // Tess: the user edited the card's description since: both texts are kept.
    yield* insert("card-tess", "card", persona("Tess", "Tess, edited."))
    yield* insert("n2-tess", "note", description("card-tess", "Tess draws.", { kind: "persona_description" }))
    // Uma: an import from before the kind, its first note titled so; a later ordinary note.
    yield* insert("card-uma", "card", persona("Uma", "Uma sings."))
    yield* insert("n3-uma", "note", description("card-uma", "Uma sings."))
    yield* insert("n4-uma", "note", note({ card: "card-uma" }, "Mood"))
    // Vic: a note titled so that isn't the card's first note, so never placed anything.
    yield* insert("card-vic", "card", persona("Vic", "Vic rows."))
    yield* insert("n5-vic", "note", note({ card: "card-vic" }, "Character's Note"))
    yield* insert("n6-vic", "note", description("card-vic", "Vic rows."))
    // Wren: its description note is in the bin, so the assembler sent the card's description.
    yield* insert("card-wren", "card", persona("Wren", "Wren hums."))
    yield* insert("n7-wren", "note", description("card-wren", "Wren hums.", { kind: "persona_description" }), true)
    // The other kinds and origins, untouched.
    yield* insert("card-aria", "card", cardDoc("Aria"))
    yield* insert(
      "n8-can",
      "note",
      note({ card: "card-aria" }, "Character author's note", { kind: "character_author_note", placement: atTop })
    )
    yield* insert("n9-module", "note", note({ card: "card-aria" }, "Outfit", { module_id: "outfit" }))
    yield* insert("n10-an", "note", note({ chat: "chat" }, "Author's Note", { kind: "author_note" }))
    yield* insert(
      "n11-summary",
      "note",
      note({ chat: "chat" }, "Summary", { kind: "imported_summary", placement: { mode: "none" } })
    )
    yield* insert("n12-shared", "note", note({ shared: "global" }, "Tavern rules"))
    const before = yield* sql<{ id: string; doc_json: string }>`SELECT id, doc_json FROM entity_revisions ORDER BY seq`

    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    // Old revisions keep their documents: nothing of the user's text is lost.
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
    // The kind is gone; everything else the note shows stays.
    for (const [ref, parent] of [
      ["r-n1-sam", "n1-sam-1"],
      ["r-n2-tess", "n2-tess-1"]
    ] as const) {
      const revised = yield* head(ref)
      assert.deepStrictEqual(JSON.parse(revised.parents), [parent])
      const { kind: _, ...rest } = JSON.parse(before.find((row) => row.id === parent)!.doc_json)
      assert.deepStrictEqual(revised.doc, rest)
    }
    // A description the note holds is emptied on every head of the card, the variant included.
    for (const [ref, parent] of [
      ["r-card-sam", "card-sam-1"],
      ["variant-sam", "card-sam-v"],
      ["r-card-uma", "card-uma-1"]
    ] as const) {
      const card = yield* head(ref)
      assert.strictEqual(card.doc.description, "")
      assert.deepStrictEqual(JSON.parse(card.parents), [parent])
    }
    // Overrides: an edited description stays (and its text with it), an alike one is emptied; the
    // note's own override isn't revised, its text kept.
    assert.strictEqual((yield* head("over-sam-1")).head, "card-sam-e")
    assert.strictEqual((yield* head("over-sam-1")).doc.description, "Sam is curious, and shy.")
    assert.strictEqual((yield* head("over-sam-2")).doc.description, "")
    assert.strictEqual((yield* head("over-n1-sam")).head, "n1-sam-o")
    // An edited description, a note that wasn't first, a binned note and every other kind: unchanged.
    for (const ref of [
      "r-card-tess",
      "r-n3-uma",
      "r-n4-uma",
      "r-card-vic",
      "r-n5-vic",
      "r-n6-vic",
      "r-card-wren",
      "r-n7-wren",
      "r-card-aria",
      "r-n8-can",
      "r-n9-module",
      "r-n10-an",
      "r-n11-summary",
      "r-n12-shared"
    ])
      assert.strictEqual((yield* head(ref)).head, `${ref.slice(2)}-1`)
    assert.strictEqual((yield* head("r-card-tess")).doc.description, "Tess, edited.")
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])

    // Run again, it changes nothing.
    const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entity_revisions`
    yield* personaNotesMigration
    assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM entity_revisions`, [{ n: count!.n }])
  }).pipe(Effect.provide(writerConnection(join(tempDir("persona-notes-migration"), "db.sqlite"))))
)
