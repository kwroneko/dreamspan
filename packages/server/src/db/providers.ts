// Connections, models and the usage ledger in storage (spec/PROVIDERS.md §2, §3, §9):
// row shapes and their mapping, shared by the writer and the readers.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import {
  Compat,
  Connection,
  type ConnectionId,
  Model,
  type ModelId,
  ModelOverrides,
  ModelUpstream,
  type ProviderKind,
  type ProxyMode,
  type WireApi
} from "@rp/shared/providers.ts"
import {
  LlmRequest,
  type LlmRequestId,
  type RequestPurpose,
  type RequestStatus,
  type UsageSource
} from "@rp/shared/usage.ts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

export interface ConnectionRow {
  readonly id: string
  readonly owner_user_id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly api: WireApi
  readonly base_url: string | null
  readonly api_key_enc: Uint8Array | null
  readonly key_hint: string | null
  readonly headers_enc: Uint8Array | null
  readonly header_names_json: string
  readonly compat_json: string
  readonly cache_ttl_s: number | null
  readonly max_concurrent: number | null
  readonly proxy_mode: ProxyMode
  readonly proxy_url_enc: Uint8Array | null
  readonly preset_override_ref_id: string | null
  readonly row_version: number
  readonly created_at: number
  readonly updated_at: number
}

const decodeCompat = Schema.decodeUnknownSync(Compat)
const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.String))
const decodeUpstream = Schema.decodeUnknownSync(ModelUpstream)
const decodeOverrides = Schema.decodeUnknownSync(ModelOverrides)

export const toConnection = (row: ConnectionRow) =>
  new Connection({
    id: row.id as ConnectionId,
    name: row.name,
    kind: row.kind,
    api: row.api,
    baseUrl: row.base_url,
    hasKey: row.api_key_enc !== null,
    keyHint: row.key_hint,
    headerNames: decodeNames(JSON.parse(row.header_names_json)),
    compat: decodeCompat(JSON.parse(row.compat_json)),
    cacheTtlS: row.cache_ttl_s,
    maxConcurrent: row.max_concurrent,
    proxyMode: row.proxy_mode,
    presetOverrideRefId: row.preset_override_ref_id as RefId | null,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

export interface ModelRow {
  readonly id: string
  readonly connection_id: string
  readonly model_key: string
  readonly source: "fetched" | "user"
  readonly upstream_json: string
  readonly overrides_json: string
  readonly hidden: number
  readonly fetched_at: number | null
  readonly missing_since: number | null
  readonly row_version: number
}

export const toModel = (row: ModelRow) =>
  new Model({
    id: row.id as ModelId,
    connectionId: row.connection_id as ConnectionId,
    key: row.model_key,
    source: row.source,
    upstream: decodeUpstream(JSON.parse(row.upstream_json)),
    overrides: decodeOverrides(JSON.parse(row.overrides_json)),
    hidden: row.hidden === 1,
    fetchedAt: row.fetched_at,
    missingSince: row.missing_since,
    rowVersion: row.row_version
  })

export interface LlmRequestRow {
  readonly id: string
  readonly connection_id: string
  readonly model_id: string | null
  readonly chat_id: string | null
  readonly version_id: string | null
  readonly purpose: RequestPurpose
  readonly api: string
  readonly provider: string
  readonly model_key: string
  readonly response_model: string | null
  readonly upstream: string | null
  readonly status: RequestStatus
  readonly started_at: number
  readonly first_token_at: number | null
  readonly ended_at: number | null
  readonly input_uncached: number | null
  readonly cache_read: number | null
  readonly cache_write: number | null
  readonly cache_write_long: number | null
  readonly output: number | null
  readonly reasoning: number | null
  readonly usage_source: UsageSource
  readonly reported_cost: number | null
  readonly cost: number | null
  readonly cost_currency: string | null
  readonly cost_formula: string | null
}

export const toLlmRequest = (row: LlmRequestRow) =>
  new LlmRequest({
    id: row.id as LlmRequestId,
    connectionId: row.connection_id as ConnectionId,
    modelId: row.model_id as ModelId | null,
    chatId: row.chat_id as ChatId | null,
    versionId: row.version_id as VersionId | null,
    purpose: row.purpose,
    api: row.api,
    provider: row.provider,
    modelKey: row.model_key,
    responseModel: row.response_model,
    upstream: row.upstream,
    status: row.status,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at,
    endedAt: row.ended_at,
    counts: {
      inputUncached: row.input_uncached,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      cacheWriteLong: row.cache_write_long,
      output: row.output,
      reasoning: row.reasoning
    },
    usageSource: row.usage_source,
    reportedCost: row.reported_cost,
    cost:
      row.cost === null
        ? null
        : { amount: row.cost, currency: row.cost_currency ?? "", formula: row.cost_formula ?? "" }
  })

/**
 * Lookups that enforce ownership: another user's connection, or a deleted one, is
 * NotFound (ARCHITECTURE §3.8). Until shared connections exist, a connection is usable
 * only by its owner.
 */
export const makeProviderQueries = (sql: SqlClient.SqlClient) => {
  const ownedConnection = (userId: UserId, connectionId: string) =>
    sql<ConnectionRow>`SELECT * FROM connections
      WHERE id = ${connectionId} AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "connection", id: connectionId }))
      )
    )

  const ownedModel = (userId: UserId, modelId: string) =>
    sql<ModelRow>`SELECT m.* FROM models m JOIN connections c ON c.id = m.connection_id
      WHERE m.id = ${modelId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND c.purged_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "model", id: modelId }))
      )
    )

  return { ownedConnection, ownedModel }
}
