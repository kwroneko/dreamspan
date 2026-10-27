// Runs only in the writer's migration transaction (DESIGN §4.1, §5.0). Old revisions keep
// their documents: cards keep `modules`, notes have no `on_by_default`.
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"

/** Where a module without a placement goes as a note: with the definitions. */
const WITH_THE_DEFINITIONS = { mode: "section", section: "after_main_prompt", role: "system" } as const

export const notesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const at = Date.now()

  /** A revision on a ref's head, which becomes the head. */
  const revise = (ref: { id: string; entity_id: string; head_revision_id: string }, doc: Doc, message: string) =>
    Effect.gen(function* () {
      const id = uuidv7()
      yield* sql`INSERT INTO entity_revisions ${sql.insert({
        id,
        entity_id: ref.entity_id,
        parents: JSON.stringify([ref.head_revision_id]),
        doc_json: JSON.stringify(doc),
        doc_hash: docHash(doc),
        search_text: searchText(doc),
        schema_version: NOTE_SCHEMA_VERSION,
        origin: "user",
        message,
        created_at: at
      })}`
      yield* sql`UPDATE entity_refs SET head_revision_id = ${id}, row_version = row_version + 1, updated_at = ${at}
        WHERE id = ${ref.id}`
    })

  // 1. A card's first note was on in every chat unless switched off there (ST's Character's
  // Note): it says so itself now, so nothing a chat sends changes. A note made from a module
  // (step 2, on an earlier run) or ST's Character Author's Note is never that note.
  const firsts = yield* sql<{ id: string; entity_id: string; head_revision_id: string; doc_json: string }>`
    SELECT r.id, r.entity_id, r.head_revision_id, h.doc_json FROM entity_refs r
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE r.ref_kind = 'upstream' AND r.entity_id IN (
      SELECT min(e.id) FROM entities e
      JOIN entity_refs u ON u.entity_id = e.id AND u.ref_kind = 'upstream'
      JOIN entity_revisions v ON v.id = u.head_revision_id
      WHERE e.kind = 'note' AND e.deleted_at IS NULL AND json_extract(v.doc_json, '$.owner.card') IS NOT NULL
        AND json_extract(v.doc_json, '$.module_id') IS NULL
        AND coalesce(json_extract(v.doc_json, '$.kind'), '') <> 'character_author_note'
      GROUP BY e.owner_user_id, json_extract(v.doc_json, '$.owner.card'))`
  for (const first of firsts) {
    const doc = JSON.parse(first.doc_json) as Doc
    if (doc.on_by_default === true) continue
    yield* revise(first, { ...doc, on_by_default: true }, "On in every chat, as the card's first note was")
  }

  // 2. Card modules are card notes (DESIGN §5.0): every module in a card's ref heads, each
  // once by its id, becomes a note of the card, off in chats. One made already is kept.
  const heads = yield* sql<{ entity_id: string; owner: string; doc_json: string }>`
    SELECT r.entity_id, e.owner_user_id AS owner, h.doc_json FROM entity_refs r
    JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.kind = 'card' AND e.purged_at IS NULL AND json_array_length(h.doc_json, '$.modules') > 0
    ORDER BY r.entity_id, r.ref_kind <> 'upstream', r.id`
  const made = new Set<string>()
  for (const head of heads) {
    const modules = (JSON.parse(head.doc_json) as Doc).modules
    for (const module of Array.isArray(modules) ? modules : []) {
      if (!Predicate.isObject(module) || typeof module.id !== "string") continue
      const key = `${head.entity_id}\u0000${module.id}`
      if (made.has(key)) continue
      made.add(key)
      const [existing] = yield* sql<{ n: number }>`
        SELECT count(*) AS n FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
        JOIN entity_revisions h ON h.id = r.head_revision_id
        WHERE e.kind = 'note' AND json_extract(h.doc_json, '$.owner.card') = ${head.entity_id}
          AND json_extract(h.doc_json, '$.module_id') = ${module.id}`
      if (existing!.n > 0) continue
      const title = typeof module.title === "string" ? module.title : ""
      const doc: Doc = {
        schema_version: NOTE_SCHEMA_VERSION,
        title,
        content: typeof module.content === "string" ? module.content : "",
        placement: Predicate.isObject(module.placement) ? module.placement : WITH_THE_DEFINITIONS,
        owner: { card: head.entity_id },
        exportable: module.exportable !== false,
        ...(module.agent_editable === true ? { agent_editable: true } : {}),
        module_id: module.id
      }
      const entity = uuidv7()
      const revision = uuidv7()
      yield* sql`INSERT INTO entities ${sql.insert({ id: entity, owner_user_id: head.owner, kind: "note", created_at: at })}`
      yield* sql`INSERT INTO entity_revisions ${sql.insert({
        id: revision,
        entity_id: entity,
        parents: "[]",
        doc_json: JSON.stringify(doc),
        doc_hash: docHash(doc),
        search_text: searchText(doc),
        schema_version: NOTE_SCHEMA_VERSION,
        origin: "user",
        message: "Made from the card's module",
        created_at: at
      })}`
      yield* sql`INSERT INTO entity_refs ${sql.insert({
        id: uuidv7(),
        entity_id: entity,
        ref_kind: "upstream",
        head_revision_id: revision,
        merge_base_revision_id: null,
        label: title.slice(0, 200) || "Module",
        subtitle: "",
        created_at: at,
        updated_at: at
      })}`
    }
  }
})
