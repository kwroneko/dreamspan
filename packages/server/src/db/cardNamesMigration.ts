// Runs only in the writer's migration transaction. Old revisions and draft bases stay intact.
import { uuidv7 } from "@rp/shared/id.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"

export const cardNamesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const refs = yield* sql<{
    id: string
    entity_id: string
    head_revision_id: string
    label: string
    subtitle: string
    doc_json: string
    schema_version: number
  }>`SELECT r.*, v.doc_json, v.schema_version FROM entity_refs r
    JOIN entities e ON e.id = r.entity_id JOIN entity_revisions v ON v.id = r.head_revision_id
    WHERE e.kind = 'card' AND e.purged_at IS NULL ORDER BY r.id`
  for (const ref of refs) {
    const before = JSON.parse(ref.doc_json) as Doc
    const nameChanged = ref.label !== "" && before.name !== ref.label
    const versionChanged = ref.subtitle !== "" && (before.character_version ?? "") !== ref.subtitle
    if (!nameChanged && !versionChanged) continue
    // A former library-only rename must not also rename the character the model sees.
    const doc: Doc = {
      ...before,
      ...(nameChanged ? { name: ref.label } : {}),
      ...(versionChanged ? { character_version: ref.subtitle } : {}),
      ...(!before.nickname && typeof before.name === "string" && nameChanged ? { nickname: before.name } : {})
    }
    const id = uuidv7()
    const at = Date.now()
    yield* sql`INSERT INTO entity_revisions ${sql.insert({
      id,
      entity_id: ref.entity_id,
      parents: JSON.stringify([ref.head_revision_id]),
      doc_json: JSON.stringify(doc),
      doc_hash: docHash(doc),
      search_text: searchText(doc),
      schema_version: ref.schema_version,
      origin: "user",
      origin_ref: ref.id,
      message: "Preserved library display name and subtitle in standard card fields",
      created_at: at
    })}`
    yield* sql`UPDATE entity_refs SET head_revision_id = ${id}, row_version = row_version + 1,
      updated_at = ${at} WHERE id = ${ref.id}`
  }
  // These columns remain useful for generic library queries, but are caches for cards.
  for (const [suffix, event] of [
    ["insert", "INSERT"],
    ["update", "UPDATE OF head_revision_id, label, subtitle"]
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER card_names_${suffix} AFTER ${event} ON entity_refs
      WHEN (SELECT kind FROM entities WHERE id = NEW.entity_id) = 'card'
        AND (NEW.label IS NOT coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
          OR NEW.subtitle IS NOT coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), ''))
      BEGIN UPDATE entity_refs SET
        label = coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), ''),
        subtitle = coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
        WHERE id = NEW.id; END`)
  }
  // Refs with unset legacy metadata keep their heads; populate their derived caches too.
  yield* sql`UPDATE entity_refs SET label = label WHERE entity_id IN (
    SELECT id FROM entities WHERE kind = 'card' AND purged_at IS NULL
  )`
})
