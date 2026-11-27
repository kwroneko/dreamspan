import { backgroundHeldBy } from "./backgroundMedia.ts"
import { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { galleryAssets } from "@dreamspan/shared/gallery.ts"
import { Schema } from "effect"
import { revisionNumber } from "./revisionNumbers.ts"
import { lcmPath } from "./lcmPath.ts"
import { inFork, viewAt } from "./forkState.ts"
import { stateEventRowsThrough } from "./stateRead.ts"
import { agentWrittenNotes, notesCreated } from "./agentNotes.ts"
import { chatFork, readSnippet } from "./snippets.ts"
// The editors' read handlers (ARCHITECTURE.md "Editing the library"), in the reader workers.
import { EditorSnapshot, NoteEntry, SharedNote } from "@dreamspan/shared/editorApi.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { entityDraftTarget } from "@dreamspan/shared/drafts.ts"
import { applyDrafts } from "@dreamspan/shared/editing.ts"
import type { Doc, RevisionId } from "@dreamspan/shared/library.ts"
import { editedDoc } from "@dreamspan/shared/presetConditions.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { attachmentHeldBy, isMediaPath, mediaHeldBy, stagedAttachmentHeldBy } from "./media.ts"
import { noteAt, noteHere, otherBranches } from "./noteAt.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { linkCounts, linkedNote, sharedNote } from "./sharedNotes.ts"
import { query } from "./tx.ts"

export const makeEditorReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  const drafts = makeDraftStore(sql)

  const handlers = {
    ListSnippets: ({ userId, chatId, query: search }) =>
      Effect.gen(function* () {
        yield* chatFork(sql, userId, chatId, null)
        const refs = yield* lib.refsWhere("e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL", [userId])
        const items = yield* Effect.forEach(refs, (ref) => readSnippet(sql, userId, ref, chatId))
        const needle = search?.trim().toLocaleLowerCase() ?? ""
        return items
          .filter((item) => item !== null)
          .filter((item) => `${item.title} ${item.content}`.toLocaleLowerCase().includes(needle))
          .sort((a, b) => a.title.localeCompare(b.title))
      }).pipe(query("ListSnippets")),
    GetCardGallery: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* new NotFound({ entity: "card", id: refId })
        const doc = Schema.decodeUnknownSync(CardDoc)(yield* lib.loadDoc(ref.head_revision_id))
        return {
          name: doc.name,
          images: galleryAssets(doc).map((a) => ({ uri: a.uri, name: a.name, mediaId: doc.asset_media_ids![a.uri]! }))
        }
      }).pipe(query("GetCardGallery")),
    OpenEditor: ({ userId, refId, chatNote }) =>
      Effect.gen(function* () {
        const owned = yield* lib.ownedRef(userId, refId)
        const resolved = chatNote ? yield* noteHere(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        const usedByChats = yield* lib.usedByChats(userId, { ...ref, id: refId })
        // A chat's own note's drafts are its branch's (owner, 2026-11-01).
        const target = entityDraftTarget(refId, resolved?.scope)
        const draftRows = yield* sql<Parameters<typeof drafts.toDraft>[0]>`
          SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
          FROM drafts d
          WHERE d.user_id = ${userId} AND d.target_kind = 'entity_field' AND d.target_id = ${target}
          ORDER BY d.field`
        // Its family's entries, the original and every fork of a fork, as they're listed.
        const family = ref.kind === "card" ? null : yield* lib.libraryFamily(userId, ref.entity_id, ref.kind)
        const members = (family?.members ?? []).filter(
          (m) => m.refId !== null && (m.state === "live" || m.state === "archived")
        )
        const variants =
          members.length === 0
            ? []
            : yield* lib.refsWhere(
                `r.id IN (${members.map(() => "?").join(", ")})`,
                members.map((m) => m.refId)
              )
        return new EditorSnapshot({
          ref: toLibraryRef(ref),
          doc: editedDoc(ref.kind, resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id))),
          usedByChats,
          drafts: draftRows.map((row) => drafts.toDraft(row)),
          revisionNumber: yield* revisionNumber(sql, ref.head_revision_id),
          variants: variants.map(toLibraryRef),
          ...(resolved && chatNote
            ? {
                chatNote: {
                  scope: resolved.scope,
                  otherBranches: yield* otherBranches(sql, lib, userId, owned, chatNote.chatId, resolved)
                }
              }
            : {})
        })
      }).pipe(query("OpenEditor")),

    // Indexed both ways (entities_forked_from): only cards in a relation are visited.
    CardFamilyIndex: ({ userId }) =>
      sql<{ entityId: EntityId; forks: number }>`
        SELECT e.id AS "entityId", (SELECT count(*) FROM entities c WHERE c.forked_from_entity_id = e.id) AS forks
        FROM entities e WHERE e.owner_user_id = ${userId} AND e.kind = 'card'
          AND (e.forked_from_entity_id IS NOT NULL
            OR e.id IN (SELECT forked_from_entity_id FROM entities WHERE forked_from_entity_id IS NOT NULL))`.pipe(
        query("CardFamilyIndex")
      ),

    CardFamily: ({ userId, entityId }) =>
      Effect.flatMap(lib.libraryFamily(userId, entityId), (family) =>
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

    GetAttachedLibraryRevision: ({ userId, chatId, forkId, leafSlotId, kind, refId, revisionId }) =>
      Effect.gen(function* () {
        const missing = new NotFound({ entity: "attached revision", id: revisionId })
        const [chat] = yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}
          AND kind = 'workshop' AND deleted_at IS NULL`
        if (!chat) return yield* missing
        const path = yield* lcmPath(
          sql,
          userId,
          chatId,
          leafSlotId,
          undefined,
          Number.MAX_SAFE_INTEGER,
          undefined,
          false
        )
        const ids = path.flatMap(({ versionId }) => (versionId ? [versionId] : []))
        const [held] = yield* sql<{ name: string; doc: string }>`
          SELECT l.name, coalesce(r.doc_json, p.doc_json) AS doc
          FROM version_library l
          LEFT JOIN entity_revisions r ON r.id = l.revision_id
          LEFT JOIN purged_library_documents p ON p.revision_id = l.revision_id
          WHERE l.ref_id = ${refId} AND l.revision_id = ${revisionId} AND l.kind = ${kind}
            AND (r.id IS NOT NULL OR p.revision_id IS NOT NULL)
            AND l.version_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
          LIMIT 1`
        if (!held) return yield* missing
        return { name: held.name, doc: JSON.parse(held.doc) as Doc }
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("GetAttachedLibraryRevision")),

    ListCardNotes: ({ userId, cardRefId }) =>
      Effect.gen(function* () {
        const card = yield* lib.ownedRef(userId, cardRefId)
        const notes = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.card') = ?`,
          [userId, card.entity_id]
        )
        // Live text is what's sent (§14.2a): a note as typed, its active drafts on its head.
        const live = (refId: string, head: Doc) =>
          Effect.map(
            sql<{ field: string; content: string }>`SELECT field, content FROM drafts WHERE user_id = ${userId}
              AND target_kind = 'entity_field' AND target_id = ${refId} AND status = 'active' ORDER BY field`,
            (rows) => (rows.length === 0 ? head : applyDrafts("note", head, rows).doc)
          )
        return yield* Effect.forEach(notes, (note) =>
          Effect.gen(function* () {
            const doc = yield* lib.loadDoc(note.head_revision_id)
            const sent = yield* live(note.id, doc)
            // A linked slot sends its shared note's text, as the assembler reads it; one linked
            // to a shared note in the bin sends nothing.
            const link = typeof sent.link === "string" ? sent.link : null
            const shared = link === null ? null : yield* sharedNote(sql, userId, link)
            const content =
              link === null
                ? sent.content
                : shared && shared.deleted !== 1
                  ? (yield* live(shared.ref_id, { content: shared.content ?? "" })).content
                  : undefined
            return new NoteEntry({
              ref: toLibraryRef(note),
              doc,
              ...(typeof content === "string" ? { sent: { ...sent, content } } : {})
            })
          })
        )
      }).pipe(query("ListCardNotes")),

    ChatNoteEntries: ({ userId, chatId, forkId, slotId, cards }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        const rows = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
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
        // A note an agent reply wrote (its first revision is the reply's) belongs to that reply
        // (DESIGN §7.3 [D]): its creation event must be on the path, whatever the current switch.
        const byAgent = yield* agentWrittenNotes(
          sql,
          notes.filter((n) => cardOf(n.doc) === null).map((n) => n.row.entity_id)
        )
        const named =
          byAgent.size > 0
            ? yield* notesCreated(
                sql,
                yield* stateEventRowsThrough(sql, chatId, slotId, yield* viewAt(sql, chatId, slotId)),
                byAgent
              )
            : new Set<string>()
        const listed = notes.filter((n) => !byAgent.has(n.row.entity_id) || named.has(n.row.entity_id))
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
            ...listed.filter((n) => cardOf(n.doc) === null),
            ...cards.flatMap((card) => listed.filter((n) => cardOf(n.doc) === card))
          ],
          entry
        )
      }).pipe(inFork(sql, chatId, forkId, slotId), query("ChatNoteEntries")),

    ListSharedNoteRefs: ({ userId }) =>
      lib
        .refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.shared') = 'global'`,
          [userId]
        )
        .pipe(
          Effect.map((rows) => rows.map(toLibraryRef)),
          query("ListSharedNoteRefs")
        ),

    SharedNoteHead: ({ userId, entityId }) =>
      sharedNote(sql, userId, entityId).pipe(
        Effect.map((shared) =>
          shared === null ? null : { revisionId: shared.head as RevisionId, scope: shared.scope }
        ),
        query("SharedNoteHead")
      ),

    ListSharedNotes: ({ userId, query: search, refId, entityId, chatNote }) =>
      Effect.gen(function* () {
        if (chatNote) yield* chatFork(sql, userId, chatNote.chatId, chatNote.forkId ?? null)
        // SQLite LIKE's case folding is ASCII-only, so titles are matched here.
        const rows = yield* lib.refsWhere(
          `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
           AND (? IS NULL OR r.id = ?) AND (? IS NULL OR e.id = ?)
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.shared') IS NOT NULL`,
          [userId, refId ?? null, refId ?? null, entityId ?? null, entityId ?? null]
        )
        const needle = search?.trim().toLocaleLowerCase() ?? ""
        const docs = yield* Effect.forEach(rows, (row) =>
          Effect.map(lib.loadDoc(row.head_revision_id), (doc) => ({ row, doc }))
        )
        const visible = []
        for (const { row, doc } of docs) {
          const scope = (doc.owner as { shared?: string } | undefined)?.shared
          if (scope === "global") {
            visible.push({ row, doc })
            continue
          }
          // A chat's snippet is there in every branch of it.
          if (chatNote && scope === chatNote.chatId) visible.push({ row, doc })
        }
        const found = visible.filter(({ doc }) =>
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

    GetMediaFile: ({ userId, mediaId, attachmentOnly, backgroundOnly, includeStaged }) =>
      Effect.gen(function* () {
        const [file] = yield* sql<{ path: string; mime: string; byteSize: number }>`
          SELECT m.path, m.mime, m.byte_size AS byteSize FROM media_assets m
          WHERE m.id = ${mediaId} AND ${
            backgroundOnly
              ? backgroundHeldBy(sql, "m.id", userId)
              : attachmentOnly
                ? attachmentHeldBy(sql, "m.id", userId)
                : sql`(${mediaHeldBy(sql, "m.id", userId)}
                ${includeStaged ? sql`OR ${stagedAttachmentHeldBy(sql, "m.id", userId)}` : sql``})`
          }`
        if (!file || !isMediaPath(file.path)) return yield* new NotFound({ entity: "media", id: mediaId })
        return file
      }).pipe(query("GetMediaFile"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
