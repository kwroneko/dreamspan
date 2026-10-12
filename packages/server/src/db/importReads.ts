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
    ExportSource: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const json = yield* docJson(ref.head_revision_id)
        const source = { kind: ref.kind, label: ref.label, docJson: json, noteDocJson: null, avatar: null, assets: [] }
        if (ref.kind !== "card") return new ExportSource(source)
        const note = yield* lib.cardNote(userId, ref.entity_id)
        const doc = JSON.parse(json) as Record<string, unknown>
        const assetIds = Predicate.isObject(doc.asset_media_ids) ? Object.entries(doc.asset_media_ids) : []
        const assets = yield* Effect.forEach(assetIds, ([uri, id]) =>
          Effect.map(ownedMedia(userId, id), (file) => (file ? [{ uri, ...file }] : []))
        )
        return new ExportSource({
          ...source,
          noteDocJson: note && (yield* docJson(note.head_revision_id)),
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
