// The editors' read handlers (ARCHITECTURE.md "Editing the library"), in the reader workers.
import { EditorSnapshot, NoteEntry, SharedNote } from "@rp/shared/editorApi.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { Doc } from "@rp/shared/library.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { isMediaPath } from "./media.ts"
import { noteAt } from "./noteAt.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { linkCounts, linkedNote, sharedNote } from "./sharedNotes.ts"
import { query } from "./tx.ts"

export const makeEditorReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  const drafts = makeDraftStore(sql)

  const handlers = {
    OpenEditor: ({ userId, refId, chatNote }) =>
      Effect.gen(function* () {
        const owned = yield* lib.ownedRef(userId, refId)
        const resolved = chatNote ? yield* noteAt(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        const usedByChats = yield* lib.usedByChats(userId, { ...ref, id: refId })
        const draftRows = yield* sql<Parameters<typeof drafts.toDraft>[0]>`
          SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
          FROM drafts d
          WHERE d.user_id = ${userId} AND d.target_kind = 'entity_field' AND d.target_id = ${refId}
          ORDER BY d.field`
        const variants =
          ref.kind === "card"
            ? []
            : yield* lib.refsWhere("r.entity_id = ? AND r.ref_kind <> 'chat_override'", [ref.entity_id])
        return new EditorSnapshot({
          ref: toLibraryRef(ref),
          doc: editedDoc(ref.kind, resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id))),
          usedByChats,
          drafts: draftRows.map((row) => drafts.toDraft(row)),
          variants: variants.map(toLibraryRef)
        })
      }).pipe(query("OpenEditor")),

    CardFamily: ({ userId, entityId }) =>
      Effect.flatMap(lib.cardFamily(userId, entityId), (family) =>
        family === null ? Effect.fail(new NotFound({ entity: "card", id: entityId })) : Effect.succeed(family)
      ).pipe(query("CardFamily")),

    GetRevisionDoc: ({ userId, refId, revisionId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        // A draft's base may be the parent's, for a draft moved along with a fork.
        const row = yield* lib.draftBase(ref.entity_id, revisionId)
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

    ChatNoteEntries: ({ userId, chatId, forkId, slotId, cards }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        const rows = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
           AND EXISTS (SELECT 1 FROM entity_revisions h WHERE h.id = r.head_revision_id
             AND (json_extract(h.doc_json, '$.owner.chat') = ?
               OR json_extract(h.doc_json, '$.owner.card') IN (SELECT value FROM json_each(?))))`,
          [userId, chatId, JSON.stringify(cards)]
        )
        const notes = yield* Effect.forEach(
          rows.toSorted((a, b) => (a.entity_id < b.entity_id ? -1 : 1)),
          (row) =>
            Effect.gen(function* () {
              const doc = yield* lib.loadDoc(row.head_revision_id)
              if ((doc.owner as { chat?: string } | undefined)?.chat !== chatId) return { row, doc }
              const resolved = yield* noteAt(sql, lib, userId, row, { chatId, forkId: forkId ?? null, slotId })
              return { row: resolved.ref, doc: resolved.doc }
            })
        )
        const cardOf = (doc: Doc) => {
          const owner = doc["owner"] as { card?: EntityId } | undefined
          return owner?.card ?? null
        }
        // A linked slot shows its shared note's text, as the assembler sends it.
        const entry = ({ row, doc }: (typeof notes)[number]) =>
          Effect.gen(function* () {
            const link = typeof doc.link === "string" ? doc.link : null
            const linked = link === null ? null : yield* linkedNote(sql, userId, link)
            const shared = linked && (yield* sharedNote(sql, userId, linked.entityId))
            return {
              ref: toLibraryRef(row),
              doc: shared ? { ...doc, content: shared.content } : doc,
              card: cardOf(doc),
              linked
            }
          })
        return yield* Effect.forEach(
          [
            ...notes.filter((n) => cardOf(n.doc) === null),
            ...cards.flatMap((card) => notes.filter((n) => cardOf(n.doc) === card))
          ],
          entry
        )
      }).pipe(query("ChatNoteEntries")),

    ListSharedNotes: ({ userId, query: search, refId, entityId }) =>
      Effect.gen(function* () {
        // SQLite LIKE's case folding is ASCII-only, so titles are matched here.
        const rows = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
           AND (? IS NULL OR r.id = ?) AND (? IS NULL OR e.id = ?)
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.shared') IS NOT NULL`,
          [userId, refId ?? null, refId ?? null, entityId ?? null, entityId ?? null]
        )
        const needle = search?.trim().toLocaleLowerCase() ?? ""
        const docs = yield* Effect.forEach(rows, (row) =>
          Effect.map(lib.loadDoc(row.head_revision_id), (doc) => ({ row, doc }))
        )
        const found = docs.filter(({ doc }) =>
          String(doc.title ?? "")
            .toLocaleLowerCase()
            .includes(needle)
        )
        const counts = yield* linkCounts(
          sql,
          userId,
          found.map(({ row }) => row.entity_id)
        )
        return found
          .map(
            ({ row, doc }) =>
              new SharedNote({
                ref: toLibraryRef(row),
                title: String(doc.title ?? ""),
                excerpt: String(doc.content ?? "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 160),
                usedBy: counts.get(row.entity_id) ?? 0
              })
          )
          .toSorted((a, b) => a.title.localeCompare(b.title) || (a.ref.id < b.ref.id ? -1 : 1))
      }).pipe(query("ListSharedNotes")),

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
