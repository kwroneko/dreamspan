// Library items a workshop message carries (spec/WORKSHOP-CARDS.md §4.4): `version_library`
// rows, one per card, lorebook or preset, at the revision that was its head when the message was
// written, and its name then. Written inside the version insert's transaction; a new version
// made from another (an edit, a copy into a fork or a changeset) carries its source's list.
import type { MessageLibrary, NewVersion } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

/** Whether the selected version (`v`) has content to send, without loading the payload. */
export const hasVersionPayload = (sql: SqlClient.SqlClient) => sql`(v.content_length > 0
  OR EXISTS (SELECT 1 FROM version_attachments a WHERE a.version_id = v.id)
  OR EXISTS (SELECT 1 FROM version_library l WHERE l.version_id = v.id))`

export type LibraryPin = MessageLibrary[number] & {
  readonly revisionId: string
  readonly name: string
}

export type VersionWithLibraryPins = NewVersion & { readonly libraryPins?: ReadonlyArray<LibraryPin> }

/**
 * Resolve the sender's live workshop items in the send transaction. Keep their order and
 * capture their names and revisions before the message waits behind a running reply.
 */
export const pinLibrary = (sql: SqlClient.SqlClient, ownerId: string, chatId: string, items: MessageLibrary) =>
  Effect.gen(function* () {
    const pins: Array<LibraryPin> = []
    if (items.length === 0) return pins
    const [chat] = yield* sql<{ kind: string }>`SELECT kind FROM chats WHERE id = ${chatId}`
    if (chat?.kind !== "workshop") return yield* new NotFound({ entity: "ref", id: items[0]!.refId })
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.refId + ":" + item.kind)) continue
      seen.add(item.refId + ":" + item.kind)
      const [ref] = yield* sql<{ revisionId: string; name: string }>`
        SELECT r.head_revision_id AS revisionId, r.label AS name
        FROM entity_refs r JOIN entities e ON e.id = r.entity_id
        WHERE r.id = ${item.refId} AND e.owner_user_id = ${ownerId} AND e.kind = ${item.kind}
          AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`
      if (!ref) return yield* new NotFound({ entity: "ref", id: item.refId })
      pins.push({ ...item, ...ref })
    }
    return pins
  })

/** Write the revisions captured by the send, even if the item's head or bin status has changed. */
export const attachLibrary = (sql: SqlClient.SqlClient, versionId: string, pins: ReadonlyArray<LibraryPin>) =>
  Effect.forEach(
    pins,
    ({ kind, refId, revisionId, name }, ordinal) => sql`
      INSERT INTO version_library (version_id, ordinal, kind, ref_id, revision_id, name)
      SELECT ${versionId}, ${ordinal}, ${kind}, ${refId}, ${revisionId}, ${name}
      WHERE EXISTS (SELECT 1 FROM entity_revisions WHERE id = ${revisionId})
        AND EXISTS (SELECT 1 FROM entity_refs WHERE id = ${refId})`,
    { discard: true }
  )

/** Version `to`, made from `from`, carries `from`'s library items as they were recorded. */
export const copyLibrary = (sql: SqlClient.SqlClient, from: string, to: string) =>
  sql`INSERT INTO version_library (version_id, ordinal, kind, ref_id, revision_id, name)
    SELECT ${to}, ordinal, kind, ref_id, revision_id, name FROM version_library WHERE version_id = ${from}`
