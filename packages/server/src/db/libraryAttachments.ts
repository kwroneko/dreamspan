// Library items a workshop message carries (spec/WORKSHOP-CARDS.md §4.4): `version_library`
// rows, one per card, lorebook or preset, at the revision that was its head when the message was
// written, and its name then. Written inside the version insert's transaction; a new version
// made from another (an edit, a copy into a fork or a changeset) carries its source's list.
import type { MessageLibrary } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

/** Whether the selected version (`v`) has content to send, without loading the payload. */
export const hasVersionPayload = (sql: SqlClient.SqlClient) => sql`(v.content_length > 0
  OR EXISTS (SELECT 1 FROM version_attachments a WHERE a.version_id = v.id)
  OR EXISTS (SELECT 1 FROM version_library l WHERE l.version_id = v.id))`

/** A live library entry of `ownerId`'s of the kind named: its head revision and its name now. */
const liveRef = (sql: SqlClient.SqlClient, ownerId: string, item: MessageLibrary[number]) =>
  Effect.map(
    sql<{ head: string; label: string }>`
      SELECT r.head_revision_id AS head, r.label FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.id = ${item.refId} AND e.owner_user_id = ${ownerId} AND e.kind = ${item.kind}
        AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`,
    ([ref]) => ref ?? null
  )

/**
 * What a send must hold before anything is written: only a workshop's messages carry library
 * items, and each must be a live entry of the sender's of the kind named; otherwise NotFound
 * (the same answer as another user's id).
 */
export const checkLibrary = (sql: SqlClient.SqlClient, ownerId: string, chatId: string, items: MessageLibrary) =>
  Effect.gen(function* () {
    if (items.length === 0) return
    const [chat] = yield* sql<{ kind: string }>`SELECT kind FROM chats WHERE id = ${chatId}`
    if (chat?.kind !== "workshop") return yield* new NotFound({ entity: "ref", id: items[0]!.refId })
    for (const item of items)
      if ((yield* liveRef(sql, ownerId, item)) === null) return yield* new NotFound({ entity: "ref", id: item.refId })
  })

/**
 * Records `items` on version `versionId` of a chat of `chatKind` owned by `ownerId`, each at its
 * head revision now. A send checked them first (`checkLibrary`); a queued message posting later
 * leaves out an item deleted meanwhile rather than fail the queue. A repeated item is kept once,
 * and nothing is recorded outside a workshop.
 */
export const attachLibrary = (
  sql: SqlClient.SqlClient,
  ownerId: string,
  chatKind: string,
  versionId: string,
  items: MessageLibrary
) =>
  Effect.gen(function* () {
    if (chatKind !== "workshop") return
    const seen = new Set<string>()
    let ordinal = 0
    for (const item of items) {
      if (seen.has(item.refId)) continue
      seen.add(item.refId)
      const ref = yield* liveRef(sql, ownerId, item)
      if (ref === null) continue
      yield* sql`INSERT INTO version_library (version_id, ordinal, kind, ref_id, revision_id, name)
        VALUES (${versionId}, ${ordinal}, ${item.kind}, ${item.refId}, ${ref.head}, ${ref.label})`
      ordinal++
    }
  })

/** Version `to`, made from `from`, carries `from`'s library items as they were recorded. */
export const copyLibrary = (sql: SqlClient.SqlClient, from: string, to: string) =>
  sql`INSERT INTO version_library (version_id, ordinal, kind, ref_id, revision_id, name)
    SELECT ${to}, ordinal, kind, ref_id, revision_id, name FROM version_library WHERE version_id = ${from}`
