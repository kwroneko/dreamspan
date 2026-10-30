// Read handlers for importing and exporting library files (ARCHITECTURE.md §11).
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { ExportSource, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeImportReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)

  const docJson = (revisionId: string) =>
    sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${revisionId}`.pipe(
      Effect.map(([row]) => row!.doc_json)
    )

  /**
   * A stored file, if the user holds a reference to it. A document is only data, and an
   * edit could name any media id in it: another user's would be NotFound everywhere else.
   */
  const ownedMedia = (userId: UserId, mediaId: unknown) =>
    typeof mediaId !== "string"
      ? Effect.succeed(undefined)
      : sql<{ path: string; mime: string; byteSize: number }>`
          SELECT m.path, m.mime, m.byte_size AS byteSize FROM media_assets m
          WHERE m.id = ${mediaId}
            AND EXISTS (SELECT 1 FROM media_refs r WHERE r.media_id = m.id AND r.owner_user_id = ${userId})`.pipe(
          Effect.map(([row]) => row)
        )

  const handlers = {
    GetCardImportNote: ({ userId, cardRefId }) =>
      Effect.gen(function* () {
        const card = yield* lib.ownedRef(userId, cardRefId)
        const note = yield* lib.cardNote(userId, card.entity_id)
        return note === null ? null : toLibraryRef(note).entityId
      }).pipe(query("GetCardImportNote")),

    ExportSource: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const json = yield* docJson(ref.head_revision_id)
        const source = {
          kind: ref.kind,
          label: ref.label,
          docJson: json,
          noteDocJson: null,
          notesDocJson: [],
          avatar: null,
          assets: []
        }
        if (ref.kind !== "card") return new ExportSource(source)
        const note = yield* lib.cardNote(userId, ref.entity_id)
        const doc = JSON.parse(json) as Record<string, unknown>
        const assetIds = Predicate.isObject(doc.asset_media_ids) ? Object.entries(doc.asset_media_ids) : []
        const assets = yield* Effect.forEach(assetIds, ([uri, id]) =>
          Effect.map(ownedMedia(userId, id), (file) => (file ? [{ uri, ...file }] : []))
        )
        // The card's notes, a linked one with its shared note's text, and none of one whose
        // shared note is in the bin: it has nothing to send. The first is ST's Character's Note.
        const notes = yield* sql<{ id: string; doc_json: string; shared: string | null }>`
          SELECT r.id, h.doc_json, (SELECT json_extract(sh.doc_json, '$.content') FROM entities se
              JOIN entity_refs sr ON sr.entity_id = se.id AND sr.ref_kind = 'upstream'
              JOIN entity_revisions sh ON sh.id = sr.head_revision_id
              WHERE se.id = json_extract(h.doc_json, '$.link') AND se.owner_user_id = ${userId}
                AND se.kind = 'note' AND se.deleted_at IS NULL) AS shared
          FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
          JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
            AND json_extract(h.doc_json, '$.owner.card') = ${ref.entity_id}
          ORDER BY e.id`
        const resolved = (row: (typeof notes)[number]) => {
          const doc = JSON.parse(row.doc_json) as Record<string, unknown>
          if (doc.link === undefined) return row.doc_json
          return row.shared === null ? null : JSON.stringify({ ...doc, content: row.shared })
        }
        const first = notes.find((row) => row.id === note?.id)
        return new ExportSource({
          ...source,
          noteDocJson: first ? resolved(first) : null,
          notesDocJson: notes.flatMap((row) => {
            const json = row === first ? null : resolved(row)
            return json === null ? [] : [json]
          }),
          avatar: (yield* ownedMedia(userId, doc.avatar_media_id)) ?? null,
          assets: assets.flat()
        })
      }).pipe(query("ExportSource")),

    GetLibraryRef: ({ userId, refId }) =>
      lib.ownedRef(userId, refId).pipe(Effect.map(toLibraryRef), query("GetLibraryRef")),

    ListMediaHashes: () =>
      sql<{ sha256: string }>`SELECT sha256 FROM media_assets`.pipe(
        Effect.map((rows) => rows.map((row) => row.sha256)),
        query("ListMediaHashes")
      ),

    IsMediaRecorded: ({ sha256 }) =>
      sql<{ n: number }>`SELECT count(*) AS n FROM media_assets WHERE sha256 = ${sha256}`.pipe(
        Effect.map(([row]) => row!.n > 0),
        query("IsMediaRecorded")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
