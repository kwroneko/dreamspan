// Runs only in the writer's migration transaction (DESIGN §4.1, owner 2026-10-28: no hidden
// note kinds). A persona's note of kind `persona_description`, or an older import's first note
// titled "Persona description", made the assembler leave the persona card's description out,
// even with the note off. That note becomes an ordinary note, and the card keeps one copy of
// the text, the note's, as an ST import makes it now. Old revisions keep their documents.
import type { Doc } from "@rp/shared/library.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"

interface Head {
  readonly id: string
  readonly entity_id: string
  readonly head_revision_id: string
  readonly schema_version: number
  readonly doc_json: string
}

export const personaNotesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const at = Date.now()

  /** A revision on a ref's head, which becomes the head. */
  const revise = (ref: Head, doc: Doc, message: string) =>
    Effect.gen(function* () {
      const id = uuidv7()
      yield* sql`INSERT INTO entity_revisions ${sql.insert({
        id,
        entity_id: ref.entity_id,
        parents: JSON.stringify([ref.head_revision_id]),
        doc_json: JSON.stringify(doc),
        doc_hash: docHash(doc),
        search_text: searchText(doc),
        schema_version: ref.schema_version,
        origin: "user",
        message,
        created_at: at
      })}`
      yield* sql`UPDATE entity_refs SET head_revision_id = ${id}, row_version = row_version + 1, updated_at = ${at}
        WHERE id = ${ref.id}`
    })

  // The notes that placed a persona's description: of the kind, or the card's first note (not
  // made from a module, nor ST's Character Author's Note) titled so without a kind. Live ones
  // only: the assembler never read a note in the bin.
  const notes = yield* sql<Head & { card: string; first: number }>`
    SELECT r.id, r.entity_id, r.head_revision_id, h.schema_version, h.doc_json,
      json_extract(h.doc_json, '$.owner.card') AS card,
      e.id = (SELECT min(f.id) FROM entities f
        JOIN entity_refs fr ON fr.entity_id = f.id AND fr.ref_kind = 'upstream'
        JOIN entity_revisions fh ON fh.id = fr.head_revision_id
        WHERE f.kind = 'note' AND f.deleted_at IS NULL AND f.owner_user_id = e.owner_user_id
          AND json_extract(fh.doc_json, '$.owner.card') = json_extract(h.doc_json, '$.owner.card')
          AND json_extract(fh.doc_json, '$.module_id') IS NULL
          AND coalesce(json_extract(fh.doc_json, '$.kind'), '') <> 'character_author_note') AS first
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.kind = 'note' AND e.deleted_at IS NULL AND json_extract(h.doc_json, '$.owner.card') IS NOT NULL
      AND (json_extract(h.doc_json, '$.kind') = 'persona_description'
        OR (json_extract(h.doc_json, '$.kind') IS NULL AND json_extract(h.doc_json, '$.title') = 'Persona description'))
    ORDER BY e.id`
  const texts = new Map<string, Set<string>>()
  for (const note of notes) {
    const { kind, ...doc } = JSON.parse(note.doc_json) as Doc
    if (kind === undefined && note.first !== 1) continue
    if (kind !== undefined)
      yield* revise(note, doc, "An ordinary note: it no longer takes the persona's description away")
    const content = typeof doc.content === "string" ? doc.content.trim() : ""
    texts.set(note.card, (texts.get(note.card) ?? new Set()).add(content))
  }

  // Every head of each such card, its variants and chat overrides included: a description the
  // note already holds is emptied, so the text is sent once, from the note. A description that
  // differs from it (the user edited one of them) is kept and is sent at the persona marker.
  const cards = [...texts.keys()]
  if (cards.length === 0) return
  const heads = yield* sql<Head>`
    SELECT r.id, r.entity_id, r.head_revision_id, h.schema_version, h.doc_json FROM entity_refs r
    JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.kind = 'card' AND e.purged_at IS NULL AND r.entity_id IN ${sql.in(cards)}
    ORDER BY r.id`
  for (const head of heads) {
    const doc = JSON.parse(head.doc_json) as Doc
    const description = typeof doc.description === "string" ? doc.description.trim() : ""
    if (description === "" || !texts.get(head.entity_id)!.has(description)) continue
    yield* revise(
      head,
      { ...doc, description: "" },
      "The description is in the persona's note, its only copy; the earlier revision keeps it too"
    )
  }
})
