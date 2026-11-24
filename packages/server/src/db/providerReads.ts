// Connection, model and ledger read handlers, in the reader workers.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ConnectionForRequest, type ReadOps } from "./ops.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { type ConnectionId, type CredentialId, ModelUse } from "@dreamspan/shared/providers.ts"
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
import { recordedPromptTotal } from "./requestInput.ts"

export const makeProviderReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { ownedConnection, ownedModel, ownedCredential } = makeProviderQueries(sql)

  const handlers = {
    GetImageTokenCount: ({ userId, sha256, kind, modelKey, detail }) =>
      sql<{ tokens: number }>`SELECT tokens FROM image_token_counts WHERE owner_user_id=${userId}
        AND sha256=${sha256} AND kind=${kind} AND model_key=${modelKey} AND detail=${detail}`.pipe(
        Effect.map(([row]) => row?.tokens ?? null),
        query("GetImageTokenCount")
      ),
    GetCostSettings: ({ userId }) =>
      sql<{
        revision: number
        value_json: string
      }>`SELECT revision, value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = 'cost'`.pipe(
        Effect.map(([row]) =>
          row
            ? {
                revision: row.revision,
                rules: JSON.parse(row.value_json) as import("@dreamspan/shared/costFormulas.ts").CostSettings["rules"]
              }
            : { revision: 0, rules: [] }
        ),
        query("GetCostSettings")
      ),
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

    ListRecomputeRows: ({ userId, modelKey, formulaPrefix, exceptFormula, afterAt, afterId, limit }) =>
      sql<{
        id: string
        connection_id: string
        kind: string
        model_id: string | null
        model_key: string
        upstream: string | null
        started_at: number
        cost_formula: string
        input_total: number | null
        input_uncached: number | null
        cache_read: number | null
        cache_write: number | null
        cache_write_long: number | null
        output: number | null
        reasoning: number | null
      }>`
        SELECT r.id, r.connection_id, c.kind, r.model_id, r.model_key, r.upstream, r.started_at, r.cost_formula,
          ${recordedPromptTotal(sql, "r.")} AS input_total, r.input_uncached, r.cache_read, r.cache_write, r.cache_write_long, r.output, r.reasoning
        FROM llm_requests r INDEXED BY llm_requests_owner JOIN connections c ON c.id = r.connection_id
        WHERE r.owner_user_id = ${userId}
          AND (r.started_at > ${afterAt} OR (r.started_at = ${afterAt} AND r.id > ${afterId}))
          AND r.status <> 'running' AND r.cost_rates_json IS NOT NULL AND r.cost_formula IS NOT 'reported'
          AND (${modelKey} IS NULL OR r.model_key = ${modelKey})
          AND (${formulaPrefix} IS NULL OR substr(r.cost_formula, 1, length(${formulaPrefix})) = ${formulaPrefix})
          AND (${exceptFormula} IS NULL OR r.cost_formula <> ${exceptFormula})
        ORDER BY r.started_at, r.id LIMIT ${Math.max(1, Math.min(limit, 1000))}`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            connectionId: row.connection_id as ConnectionId,
            kind: row.kind,
            modelId: row.model_id,
            modelKey: row.model_key,
            upstream: row.upstream,
            startedAt: row.started_at,
            formula: row.cost_formula,
            ...(row.input_total === null ? {} : { inputTotal: row.input_total }),
            inputUncached: row.input_uncached,
            cacheRead: row.cache_read,
            cacheWrite: row.cache_write,
            cacheWriteLong: row.cache_write_long,
            output: row.output,
            reasoning: row.reasoning
          }))
        ),
        query("ListRecomputeRows")
      ),

    ListPriceFeedConnections: ({ usedSince }) =>
      sql<{ owner_user_id: string; id: string }>`
        SELECT c.owner_user_id, c.id FROM connections c
        WHERE c.deleted_at IS NULL AND c.purged_at IS NULL
          AND json_extract(c.provider_settings_json, '$.priceEndpoint') = 1
          AND EXISTS (SELECT 1 FROM llm_requests r INDEXED BY llm_requests_connection
            WHERE r.connection_id = c.id AND r.started_at >= ${usedSince})
        ORDER BY c.id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            userId: row.owner_user_id as UserId,
            connectionId: row.id as ConnectionId
          }))
        ),
        query("ListPriceFeedConnections")
      ),

    // The owner index bounds the rows to the user's own requests.
    ListModelUse: ({ userId }) =>
      sql<{ connection_id: string; model_id: string; at: number }>`
        SELECT connection_id, model_id, max(started_at) AS at FROM llm_requests INDEXED BY llm_requests_owner
        WHERE owner_user_id = ${userId} AND purpose IN ('generation', 'workshop') AND model_id IS NOT NULL
        GROUP BY connection_id, model_id`.pipe(
        Effect.map((rows) =>
          rows.map(
            (row) =>
              new ModelUse({
                connectionId: row.connection_id as ModelUse["connectionId"],
                modelId: row.model_id as ModelUse["modelId"],
                lastUsedAt: row.at
              })
          )
        ),
        query("ListModelUse")
      ),

    GetModel: ({ userId, modelId }) => ownedModel(userId, modelId).pipe(Effect.map(toModel), query("GetModel")),

    GetAppSetting: ({ key }) =>
      sql<{
        value_json: string
      }>`SELECT value_json FROM settings WHERE scope = 'app' AND scope_id = '' AND key = ${key}`.pipe(
        Effect.map(([row]) => (row ? (JSON.parse(row.value_json) as unknown) : null)),
        query("GetAppSetting")
      ),

    ListLlmRequests: ({ userId, limit, before }) =>
      sql<LlmRequestRow>`SELECT *, ${recordedPromptTotal(sql)} AS input_total FROM llm_requests
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
