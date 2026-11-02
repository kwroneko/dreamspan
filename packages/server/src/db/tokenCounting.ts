// How each of a user's connections counts tokens (owner, 2026-11-02: "NEVER send anything to
// providers users didn't actually choose to… It should also be possible to specify a separate
// token counting endpoint for a connection"; DESIGN §11). On this server unless the user chose a
// provider: the connection's own, or another of their connections used only for counting.
// `user_prefs` key `token_counting`, `{ connections: { [id]: viaId } }`. Only choices whose two
// connections are still the user's and live read back; anything else counts on this server.
import type { ConnectionId } from "@rp/shared/providers.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { TokenCountingChoice } from "@rp/shared/generation.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

const KEY = "token_counting"

const stored = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{ value_json: string }>`SELECT value_json FROM user_prefs WHERE user_id = ${userId} AND key = ${KEY}`.pipe(
    Effect.map(([row]): Array<[string, string]> => {
      if (!row) return []
      const value = JSON.parse(row.value_json) as { connections?: unknown }
      const connections = value.connections
      if (!connections || typeof connections !== "object" || Array.isArray(connections)) return []
      return Object.entries(connections).filter((e): e is [string, string] => typeof e[1] === "string")
    })
  )

const owned = (sql: SqlClient.SqlClient, userId: UserId, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(new Set<string>())
    : sql<{ id: string }>`SELECT id FROM connections WHERE owner_user_id = ${userId}
        AND deleted_at IS NULL AND purged_at IS NULL AND id IN ${sql.in([...new Set(ids)])}`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.id)))
      )

/** The choices whose connections are both still the user's and live. */
const live = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const entries = yield* stored(sql, userId)
    const kept = yield* owned(sql, userId, entries.flat())
    return entries
      .filter(([id, via]) => kept.has(id) && kept.has(via))
      .map(([connectionId, via]): TokenCountingChoice => ({
        connectionId: connectionId as ConnectionId,
        via: via as ConnectionId
      }))
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
    SetTokenCounting: ({ userId, connectionId, via }) =>
      Effect.gen(function* () {
        const mine = yield* owned(sql, userId, via ? [connectionId, via] : [connectionId])
        if (!mine.has(connectionId)) return yield* new NotFound({ entity: "connection", id: connectionId })
        if (via && !mine.has(via)) return yield* new NotFound({ entity: "connection", id: via })
        const next = (yield* live(sql, userId)).filter((choice) => choice.connectionId !== connectionId)
        if (via) next.push({ connectionId, via })
        const value = { connections: Object.fromEntries(next.map((choice) => [choice.connectionId, choice.via])) }
        yield* sql`INSERT INTO user_prefs (user_id, key, value_json)
          VALUES (${userId}, ${KEY}, ${JSON.stringify(value)})
          ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
        return next
      }).pipe(transaction(sql, "SetTokenCounting"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

/** The connection whose provider counts for `connectionId`, or null: counted on this server. */
export const countingVia = (choices: ReadonlyArray<TokenCountingChoice>, connectionId: string) =>
  choices.find((choice) => choice.connectionId === connectionId)?.via ?? null
