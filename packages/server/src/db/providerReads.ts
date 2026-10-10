// Connection, model and ledger read handlers, in the reader workers.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ConnectionForRequest, type ReadOps } from "./ops.ts"
import {
  type ConnectionRow,
  type LlmRequestRow,
  makeProviderQueries,
  type ModelRow,
  toConnection,
  toLlmRequest,
  toModel
} from "./providers.ts"
import { query } from "./tx.ts"

export const makeProviderReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { ownedConnection, ownedModel } = makeProviderQueries(sql)

  const handlers = {
    ListConnections: ({ userId }) =>
      sql<ConnectionRow>`SELECT * FROM connections
        WHERE owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL ORDER BY id`.pipe(
        Effect.map((rows) => rows.map(toConnection)),
        query("ListConnections")
      ),

    GetConnection: ({ userId, connectionId }) =>
      ownedConnection(userId, connectionId).pipe(Effect.map(toConnection), query("GetConnection")),

    ResolveConnection: ({ userId, connectionId }) =>
      ownedConnection(userId, connectionId).pipe(
        Effect.map(
          (row) =>
            new ConnectionForRequest({
              connection: toConnection(row),
              apiKeyEnc: row.api_key_enc,
              headersEnc: row.headers_enc,
              proxyUrlEnc: row.proxy_url_enc
            })
        ),
        query("ResolveConnection")
      ),

    ListModels: ({ userId, connectionId, includeHidden }) =>
      Effect.gen(function* () {
        yield* ownedConnection(userId, connectionId)
        const rows = yield* sql<ModelRow>`SELECT * FROM models WHERE connection_id = ${connectionId}
          AND (${includeHidden ? 1 : 0} = 1 OR hidden = 0) ORDER BY model_key`
        return rows.map(toModel)
      }).pipe(query("ListModels")),

    GetModel: ({ userId, modelId }) => ownedModel(userId, modelId).pipe(Effect.map(toModel), query("GetModel")),

    GetAppSetting: ({ key }) =>
      sql<{ value_json: string }>`SELECT value_json FROM app_settings WHERE key = ${key}`.pipe(
        Effect.map(([row]) => (row ? (JSON.parse(row.value_json) as unknown) : null)),
        query("GetAppSetting")
      ),

    ListLlmRequests: ({ userId, limit, before }) =>
      sql<LlmRequestRow>`SELECT * FROM llm_requests
        WHERE owner_user_id = ${userId}
          AND (started_at < ${before?.startedAt ?? Number.MAX_SAFE_INTEGER}
            OR (started_at = ${before?.startedAt ?? Number.MAX_SAFE_INTEGER} AND id < ${before?.id ?? ""}))
        ORDER BY started_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toLlmRequest)),
        query("ListLlmRequests")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
