// Which of a user's connections may count the editors' text with their provider's counting
// endpoint (owner, 2026-11-02: "I think this isn't a good idea to do behind the user's back,
// especially given varying retention policies… We probably should support it but not do it by
// default"). An explicit opt-in per connection, off by default: `user_prefs` key
// `token_counting`, `{ connections: [ids] }`. Only live connections of the user's read back.
import type { ConnectionId } from "@rp/shared/providers.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

const KEY = "token_counting"

const stored = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{ value_json: string }>`SELECT value_json FROM user_prefs WHERE user_id = ${userId} AND key = ${KEY}`.pipe(
    Effect.map(([row]) => {
      if (!row) return []
      const value = JSON.parse(row.value_json) as { connections?: unknown }
      return Array.isArray(value.connections)
        ? value.connections.filter((id): id is string => typeof id === "string")
        : []
    })
  )

/** The opted-in connections that are still the user's and live. */
const live = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const ids = yield* stored(sql, userId)
    if (ids.length === 0) return []
    const rows = yield* sql<{ id: string }>`SELECT id FROM connections WHERE owner_user_id = ${userId}
      AND deleted_at IS NULL AND purged_at IS NULL AND id IN ${sql.in(ids)}`
    const kept = new Set(rows.map((row) => row.id))
    return ids.filter((id) => kept.has(id)) as Array<ConnectionId>
  })

export const makeTokenCountingReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetTokenCounting: ({ userId }) => live(sql, userId).pipe(query("GetTokenCounting"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeTokenCountingWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetTokenCounting: ({ userId, connectionId, enabled }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT id FROM connections WHERE id = ${connectionId}
          AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "connection", id: connectionId })
        const ids = (yield* live(sql, userId)).filter((id) => id !== connectionId)
        const next = enabled ? [...ids, connectionId] : ids
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json)
          VALUES (${userId}, ${KEY}, ${JSON.stringify({ connections: next })})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        return next
      }).pipe(transaction(sql, "SetTokenCounting"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
