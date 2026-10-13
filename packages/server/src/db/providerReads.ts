// Connection, model and ledger read handlers, in the reader workers.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ConnectionForRequest, type ReadOps } from "./ops.ts"
import type { CredentialId } from "@rp/shared/providers.ts"
import {
  connectionColumns,
  connectionFrom,
  type ConnectionRow,
  credentialColumns,
  type CredentialRow,
  toCredential,
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
  const { ownedConnection, ownedModel, ownedCredential } = makeProviderQueries(sql)

  const handlers = {
    CachePrefixWarm: ({ userId, connectionId, modelId, prefix, now }) =>
      Effect.gen(function* () {
        yield* ownedConnection(userId, connectionId)
        yield* ownedModel(userId, modelId)
        // This is endpoint coverage, not the display estimate's unchanged-old-prefix
        // comparison. Legacy requests without full payload hashes are conservatively cold.
        const rows = yield* sql<{ identity: string }>`
          SELECT cache_identity_json AS identity FROM llm_requests
          WHERE owner_user_id = ${userId} AND connection_id = ${connectionId} AND model_id = ${modelId}
            AND json_extract(cache_identity_json, '$.expiresAt') > ${now}
            AND (status = 'complete' OR first_token_at IS NOT NULL)
          ORDER BY started_at DESC LIMIT 100`
        return rows.some((row) => (JSON.parse(row.identity) as { prefixes: string[] }).prefixes.includes(prefix))
      }).pipe(query("CachePrefixWarm")),
    ListConnections: ({ userId }) =>
      sql<ConnectionRow>`SELECT ${sql.literal(connectionColumns)} FROM ${sql.literal(connectionFrom)}
        WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND c.purged_at IS NULL ORDER BY c.id`.pipe(
        Effect.map((rows) => rows.map(toConnection)),
        query("ListConnections")
      ),

    GetConnection: ({ userId, connectionId }) =>
      ownedConnection(userId, connectionId).pipe(Effect.map(toConnection), query("GetConnection")),

    ResolveConnection: ({ userId, connectionId }) =>
      Effect.gen(function* () {
        const row = yield* ownedConnection(userId, connectionId)
        const [owner] = yield* sql<{ role: "admin" | "user" }>`SELECT role FROM users WHERE id = ${userId}`
        const [credential] =
          row.credential_id === null
            ? []
            : yield* sql<{ id: string; key_enc: Uint8Array; origins_json: string }>`
                SELECT id, key_enc, origins_json FROM credentials WHERE id = ${row.credential_id}`
        return new ConnectionForRequest({
          connection: toConnection(row),
          credential: credential
            ? {
                id: credential.id as CredentialId,
                keyEnc: credential.key_enc,
                origins: JSON.parse(credential.origins_json) as Array<string>
              }
            : null,
          headersEnc: row.headers_enc,
          headersOrigin: row.headers_origin,
          proxyUrlEnc: row.proxy_url_enc,
          ownerRole: owner!.role
        })
      }).pipe(query("ResolveConnection")),

    ListCredentials: ({ userId }) =>
      sql<CredentialRow>`SELECT ${sql.literal(credentialColumns)} FROM credentials cr
        WHERE cr.owner_user_id = ${userId} ORDER BY cr.name, cr.id`.pipe(
        Effect.map((rows) => rows.map(toCredential)),
        query("ListCredentials")
      ),

    ResolveCredential: ({ userId, credentialId }) =>
      ownedCredential(userId, credentialId).pipe(
        Effect.map((row) => ({ keyEnc: row.key_enc })),
        query("ResolveCredential")
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
