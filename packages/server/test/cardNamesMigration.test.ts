import { assert, it } from "@effect/vitest"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardDoc } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"

it.effect("0043 preserves previous names, revisions, draft bases and divergent refs on realistic synthetic cards", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0043"))
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previous) })
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
    const folder = writeRealisticStFolder(join(tempDir("card-names-st"), "st"))
    const docs = []
    for (const file of readdirSync(join(folder, "characters"))) {
      docs.push((yield* importCard(readFileSync(join(folder, "characters", file)))).card)
    }
    docs.push(cardDoc("Original", { nickname: "", character_version: "old", description: "KEEP THIS" }))
    for (const [i, doc] of docs.entries()) {
      const entity = `e${i}`
      const revision = `v${i}`
      const label = i === docs.length - 1 ? "Library display" : doc.name
      yield* sql`INSERT INTO entities(id,owner_user_id,kind,created_at) VALUES(${entity},'u','card',1)`
      yield* sql`INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,search_text,created_at)
        VALUES(${revision},${entity},${JSON.stringify(doc)},${docHash(doc)},1,'import',${searchText(doc)},1)`
      yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,label,subtitle,created_at,updated_at)
        VALUES(${`r${i}`},${entity},'upstream',${revision},${label},${i === docs.length - 1 ? "Library version" : ""},1,1)`
    }
    const last = docs.length - 1
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,label,subtitle,created_at,updated_at)
      VALUES('fork',${`e${last}`},'variant',${`v${last}`},${`r${last}`},${`v${last}`},'Fork display','Fork version',1,1)`
    // Empty fields are unset independently: neither may erase an existing card field.
    for (const [id, label, subtitle] of [
      ["blank", "", ""],
      ["name-only", "Name only", ""],
      ["version-only", "", "Version only"]
    ]) {
      yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,label,subtitle,created_at,updated_at)
        VALUES(${id},${`e${last}`},'variant',${`v${last}`},${`r${last}`},${label},${subtitle},1,1)`
    }
    yield* sql`INSERT INTO drafts(id,user_id,target_kind,target_id,field,content,status,base_revision,created_at,updated_at)
      VALUES('d','u','entity_field',${`r${last}`},'["name"]','Pending name','active',${`v${last}`},1,1)`
    const oldRevisions = yield* sql`SELECT * FROM entity_revisions ORDER BY seq`
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM entity_revisions WHERE origin = 'import' ORDER BY seq`,
      oldRevisions
    )
    const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entity_revisions WHERE origin = 'user'`
    assert.strictEqual(count!.n, 4) // Original, fork and two mixed refs; blank legacy fields add no revisions.
    for (const [i, original] of docs.entries()) {
      if (i === last) continue
      const [unchanged] = yield* sql<{ head_revision_id: string; label: string; subtitle: string; doc_json: string }>`
        SELECT r.head_revision_id, r.label, r.subtitle, v.doc_json FROM entity_refs r
        JOIN entity_revisions v ON v.id = r.head_revision_id WHERE r.id = ${`r${i}`}`
      assert.strictEqual(unchanged!.head_revision_id, `v${i}`)
      assert.deepStrictEqual(JSON.parse(unchanged!.doc_json), original)
      assert.strictEqual(unchanged!.label, original.name)
      assert.strictEqual(unchanged!.subtitle, original.character_version)
    }
    const [blank] = yield* sql<{ head_revision_id: string; label: string; subtitle: string }>`
      SELECT head_revision_id, label, subtitle FROM entity_refs WHERE id = 'blank'`
    assert.deepStrictEqual(blank, { head_revision_id: `v${last}`, label: "Original", subtitle: "old" })
    for (const [id, name, version, nickname] of [
      ["name-only", "Name only", "old", "Original"],
      ["version-only", "Original", "Version only", ""]
    ]) {
      const [mixed] = yield* sql<{ head_revision_id: string; doc_json: string; label: string; subtitle: string }>`
        SELECT r.head_revision_id, r.label, r.subtitle, v.doc_json FROM entity_refs r
        JOIN entity_revisions v ON v.id = r.head_revision_id WHERE r.id = ${id}`
      assert.notStrictEqual(mixed!.head_revision_id, `v${last}`)
      const mixedDoc = JSON.parse(mixed!.doc_json)
      assert.strictEqual(mixedDoc.name, name)
      assert.strictEqual(mixedDoc.character_version, version)
      assert.strictEqual(mixedDoc.nickname, nickname)
      assert.strictEqual(mixed!.label, name)
      assert.strictEqual(mixed!.subtitle, version)
    }
    const [head] = yield* sql<{ doc_json: string; parents: string; doc_hash: string; search_text: string }>`
      SELECT v.* FROM entity_refs r JOIN entity_revisions v ON v.id = r.head_revision_id WHERE r.id = ${`r${last}`}`
    const doc = JSON.parse(head!.doc_json)
    assert.strictEqual(doc.name, "Library display")
    assert.strictEqual(doc.nickname, "Original")
    assert.strictEqual(doc.character_version, "Library version")
    assert.strictEqual(doc.description, "KEEP THIS")
    assert.strictEqual(head!.doc_hash, docHash(doc))
    assert.strictEqual(head!.search_text, searchText(doc))
    assert.deepStrictEqual(JSON.parse(head!.parents), [`v${last}`])
    const [fork] = yield* sql<{
      doc_json: string
    }>`SELECT v.doc_json FROM entity_refs r JOIN entity_revisions v ON v.id = r.head_revision_id WHERE r.id = 'fork'`
    assert.strictEqual(JSON.parse(fork!.doc_json).name, "Fork display")
    assert.strictEqual(JSON.parse(fork!.doc_json).character_version, "Fork version")
    assert.deepStrictEqual(yield* sql`SELECT content,base_revision FROM drafts`, [
      { content: "Pending name", base_revision: `v${last}` }
    ])
    yield* sql`UPDATE entity_refs SET label = 'Cannot diverge', subtitle = 'Cannot diverge' WHERE id = 'fork'`
    assert.deepStrictEqual(yield* sql`SELECT label,subtitle FROM entity_refs WHERE id = 'fork'`, [
      { label: "Fork display", subtitle: "Fork version" }
    ])
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM entity_revisions WHERE origin = 'user'`, [{ n: 4 }])
  }).pipe(Effect.provide(writerConnection(join(tempDir("card-names-migration"), "db.sqlite"))))
)
