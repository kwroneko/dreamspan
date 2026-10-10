// Read operation handlers. They run inside the reader workers on read-only connections.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { StateEventData } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { toStorageError } from "./connection.ts"
import { FoldableStateEvent, NotFound, ReadOps, StorageError } from "./ops.ts"
import {
  type ChatRow,
  type PathRow,
  toChat,
  toPathEntry,
  toUser,
  toVersion,
  type UserRow,
  versionColumns,
  type VersionRow
} from "./rows.ts"
import { timed } from "./timed.ts"

const decodeStateEvent = Schema.decodeUnknownEffect(StateEventData)

export const makeReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const query =
    (operation: string) =>
    <A, E, R>(body: Effect.Effect<A, E | SqlError.SqlError, R>) =>
      body.pipe(
        Effect.mapError((error): Exclude<E, SqlError.SqlError> | StorageError =>
          error instanceof SqlError.SqlError
            ? toStorageError(operation)(error)
            : (error as Exclude<E, SqlError.SqlError>)
        ),
        timed(operation)
      )

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  /** The slots from the root to `leaf`, walking parent links (DATA-MODEL §4.4). */
  const pathCte = (chatId: ChatId, leaf: SlotId) => sql`
    WITH RECURSIVE path(id, parent_slot_id) AS (
      SELECT id, parent_slot_id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
      UNION ALL
      SELECT s.id, s.parent_slot_id FROM slots s JOIN path p ON s.id = p.parent_slot_id
    )`

  return ReadOps.of({
    FindUserByHandle: ({ handle }) =>
      sql<UserRow>`SELECT * FROM users WHERE handle = ${handle}`.pipe(
        Effect.map(([row]) => (row ? toUser(row) : null)),
        query("FindUserByHandle")
      ),

    GetChat: ({ userId, chatId }) => ownedChat(userId, chatId).pipe(Effect.map(toChat), query("GetChat")),

    GetPath: ({ userId, chatId, leafSlotId, limit }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        const leaf = (leafSlotId ?? chat.active_leaf_slot_id) as SlotId | null
        if (leaf === null) return { entries: [], hasMore: false }
        // Walks up from the leaf and stops after `limit` slots.
        const rows = yield* sql<PathRow & Record<string, unknown>>`
          WITH RECURSIVE path(id, parent_slot_id, n) AS (
            SELECT id, parent_slot_id, 1 FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
            UNION ALL
            SELECT s.id, s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.parent_slot_id
            WHERE p.n < ${limit}
          )
          SELECT s.id AS slot_id, s.lane_id, s.parent_slot_id, s.depth, s.row_version, s.context_excluded,
            (SELECT count(*) FROM versions c WHERE c.slot_id = s.id) AS version_count,
            ${sql.literal(versionColumns("v"))}
          FROM path JOIN slots s ON s.id = path.id JOIN versions v ON v.id = s.selected_version_id
          ORDER BY s.depth`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: leaf })
        return { entries: rows.map(toPathEntry), hasMore: rows[0]!.parent_slot_id !== null }
      }).pipe(query("GetPath")),

    ListVersions: ({ userId, slotId }) =>
      Effect.gen(function* () {
        const rows = yield* sql<VersionRow>`
          SELECT v.* FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE v.slot_id = ${slotId} AND c.owner_user_id = ${userId} ORDER BY v.ordinal`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: slotId })
        return rows.map(toVersion)
      }).pipe(query("ListVersions")),

    StateEventsAt: ({ userId, chatId, slotId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        const rows =
          slotId === null
            ? yield* sql<{ key: string; scope: string | null; value_json: string }>`
                SELECT key, scope, value_json FROM state_events
                WHERE chat_id = ${chatId} AND slot_id IS NULL AND superseded_by_changeset IS NULL
                ORDER BY seq`
            : yield* sql<{ key: string; scope: string | null; value_json: string }>`
                ${pathCte(chatId, slotId)}
                SELECT e.key, e.scope, e.value_json
                FROM state_events e
                LEFT JOIN path p ON p.id = e.slot_id
                LEFT JOIN slots s ON s.id = p.id
                WHERE e.chat_id = ${chatId} AND e.superseded_by_changeset IS NULL
                  AND (e.slot_id IS NULL OR p.id IS NOT NULL)
                  AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
                ORDER BY coalesce(s.depth, -1), e.seq`
        return yield* Effect.forEach(rows, (row) =>
          decodeStateEvent({ key: row.key, value: JSON.parse(row.value_json) }).pipe(
            Effect.map((data) => new FoldableStateEvent({ scope: row.scope, data })),
            Effect.mapError(
              (error) => new StorageError({ reason: "corrupt", operation: "StateEventsAt", message: error.message })
            )
          )
        )
      }).pipe(query("StateEventsAt")),

    CountTo: ({ n }) =>
      sql<{ n: number }>`
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n})
        SELECT count(*) AS n FROM c`.pipe(
        Effect.map(([row]) => row?.n ?? 0),
        Effect.catchTag("SqlError", (error) => Effect.fail(toStorageError("CountTo")(error)))
      )
  })
})
