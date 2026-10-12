// The editors' read handlers (ARCHITECTURE.md "Editing the library"), in the reader workers.
import { EditorSnapshot, NoteEntry } from "@rp/shared/editorApi.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { isMediaPath } from "./media.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeEditorReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  const drafts = makeDraftStore(sql)

  const handlers = {
    OpenEditor: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        // The chats a change to this ref reaches: those whose state names it, those with an
        // override following it, and, for the entity's upstream, those the card joined. A
        // chat counts even if the card left it since: better to say too many than too few.
        const [usage] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats c
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND (
            EXISTS (SELECT 1 FROM state_events s WHERE s.chat_id = c.id
              AND s.key IN ('card.binding', 'preset.binding', 'lorebook.attach')
              AND json_extract(s.value_json, '$.ref') = ${refId})
            OR EXISTS (SELECT 1 FROM entity_refs o WHERE o.chat_id = c.id AND o.follows_ref_id = ${refId})
            OR (${ref.ref_kind === "upstream" ? 1 : 0} AND EXISTS (SELECT 1 FROM state_events s
              WHERE s.chat_id = c.id AND s.key = 'participant.join'
                AND json_extract(s.value_json, '$.entity') = ${ref.entity_id})))`
        const draftRows = yield* sql<Parameters<typeof drafts.toDraft>[0]>`
          SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
          FROM drafts d
          WHERE d.user_id = ${userId} AND d.target_kind = 'entity_field' AND d.target_id = ${refId}
          ORDER BY d.field`
        const variants = yield* lib.refsWhere("r.entity_id = ? AND r.ref_kind <> 'chat_override'", [ref.entity_id])
        return new EditorSnapshot({
          ref: toLibraryRef(ref),
          doc: yield* lib.loadDoc(ref.head_revision_id),
          usedByChats: usage!.n,
          drafts: draftRows.map(drafts.toDraft),
          variants: variants.map(toLibraryRef)
        })
      }).pipe(query("OpenEditor")),

    GetRevisionDoc: ({ userId, refId, revisionId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const [row] = yield* sql<{ doc_json: string }>`
          SELECT doc_json FROM entity_revisions WHERE id = ${revisionId} AND entity_id = ${ref.entity_id}`
        if (!row) return yield* new NotFound({ entity: "revision", id: revisionId })
        return JSON.parse(row.doc_json) as Doc
      }).pipe(query("GetRevisionDoc")),

    ListCardNotes: ({ userId, cardRefId }) =>
      Effect.gen(function* () {
        const card = yield* lib.ownedRef(userId, cardRefId)
        const notes = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.card') = ?`,
          [userId, card.entity_id]
        )
        return yield* Effect.forEach(notes, (note) =>
          Effect.map(lib.loadDoc(note.head_revision_id), (doc) => new NoteEntry({ ref: toLibraryRef(note), doc }))
        )
      }).pipe(query("ListCardNotes")),

    GetMediaFile: ({ userId, mediaId }) =>
      Effect.gen(function* () {
        const [file] = yield* sql<{ path: string; mime: string; byteSize: number }>`
          SELECT m.path, m.mime, m.byte_size AS byteSize FROM media_assets m
          WHERE m.id = ${mediaId}
            AND EXISTS (SELECT 1 FROM media_refs r WHERE r.media_id = m.id AND r.owner_user_id = ${userId})`
        if (!file || !isMediaPath(file.path)) return yield* new NotFound({ entity: "media", id: mediaId })
        return file
      }).pipe(query("GetMediaFile"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
