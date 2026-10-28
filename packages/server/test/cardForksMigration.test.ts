// 0056: a card fork's relationship on entities (spec/CARD-FORKS-DELTA.md §2). It changes no row:
// a synthetic database taken to 0055 with an imported card, a variant, chat overrides and a
// persona's ordinary note (the shape 0050 leaves) is migrated, and every table the library
// keeps is the same row for row, with the four new columns empty. Then the triggers hold.
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"

const tables = ["entities", "entity_revisions", "entity_refs", "entity_tags", "drafts", "chats"]

it.effect("0056 adds the fork columns and changes no existing row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0056"))
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previous) })
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
    yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,created_at) VALUES('chat-1','u','rp','active',1)`
    const insert = (
      entity: string,
      kind: string,
      doc: Record<string, unknown>,
      origin = "user",
      path: string | null = null
    ) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO entities(id,owner_user_id,kind,created_at) VALUES(${entity},'u',${kind},1)`
        yield* sql`INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,search_text,created_at)
          VALUES(${`${entity}-1`},${entity},${JSON.stringify(doc)},${docHash(doc)},1,${origin},${searchText(doc)},1)`
        yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,label,subtitle,source_path,created_at,updated_at)
          VALUES(${`r-${entity}`},${entity},'upstream',${`${entity}-1`},${entity},'',${path},1,1)`
        yield* sql`INSERT INTO entity_tags(entity_id,tag) VALUES(${entity},'persona')`
      })
    const persona = { ...cardDoc("Sam"), description: "" }
    yield* insert("card-sam", "card", persona)
    yield* insert("card-imp", "card", { ...cardDoc("Imp"), description: "Imported text." }, "import", "imp.png")
    const personaNote = {
      schema_version: 1,
      title: "Persona description",
      content: "Sam is curious.",
      placement: { mode: "depth", depth: 4, role: "system" },
      owner: { card: "card-sam" },
      exportable: true
    }
    yield* insert("n-sam", "note", personaNote)
    const variant = { ...persona, personality: "Shy." }
    yield* sql`INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,search_text,created_at)
      VALUES('card-sam-v','card-sam','["card-sam-1"]',${JSON.stringify(variant)},${docHash(variant)},1,'user',${searchText(variant)},2)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,label,subtitle,created_at,updated_at)
      VALUES('variant-sam','card-sam','variant','card-sam-v','r-card-sam','card-sam-1','Sam','Variant',1,1)`
    yield* sql`INSERT INTO entity_refs(id,entity_id,ref_kind,head_revision_id,follows_ref_id,merge_base_revision_id,chat_id,label,subtitle,created_at,updated_at)
      VALUES('over-sam','card-sam','chat_override','card-sam-v','r-card-sam','card-sam-1','chat-1','Sam','',1,1)`
    yield* sql`UPDATE entities SET deleted_at = 5 WHERE id = 'card-imp'`

    // A suffix keeps the client from reusing the statement prepared before the columns existed.
    const dump = (suffix: string) =>
      Effect.forEach(tables, (table) =>
        sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1, 2 ${suffix}`)
      )
    const before = yield* dump("")
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    const after = yield* dump("-- after")
    const forkColumns = ["forked_from_entity_id", "forked_from_revision_id", "forked_in_chat_id", "forked_at"]
    tables.forEach((table, at) => {
      assert.strictEqual(after[at]!.length, before[at]!.length, table)
      after[at]!.forEach((row, index) => {
        const rest = { ...row }
        if (table === "entities") {
          for (const column of forkColumns) {
            assert.strictEqual(rest[column], null, column)
            delete rest[column]
          }
        }
        assert.deepStrictEqual(rest, before[at]![index], `${table} row ${index}`)
      })
    })

    // The triggers refuse a parent of another kind, and a revision that isn't the parent's.
    const refused = (statement: string) =>
      Effect.map(Effect.result(sql.unsafe(statement)), (result) =>
        assert.strictEqual(result._tag, "Failure", statement)
      )
    yield* refused(`UPDATE entities SET forked_from_entity_id = 'n-sam' WHERE id = 'card-sam'`)
    yield* refused(`UPDATE entities SET forked_from_entity_id = 'card-sam' WHERE id = 'card-sam'`)
    yield* sql`UPDATE entities SET forked_from_entity_id = 'card-sam', forked_from_revision_id = 'card-sam-v' WHERE id = 'card-imp'`
    yield* refused(`UPDATE entities SET forked_from_revision_id = 'card-imp-1' WHERE id = 'card-imp'`)
  }).pipe(Effect.provide(writerConnection(join(tempDir("card-forks-migration"), "db.sqlite"))))
)
