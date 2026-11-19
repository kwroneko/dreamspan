// MCP connection rows as the reads and writes see them (spec/MCP.md §12): one query shape for both
// workers, so a write returns exactly what a read would. Until sharing (M5) a user sees only
// the connections they own.
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { CredentialId } from "@dreamspan/shared/providers.ts"
import {
  McpCall,
  McpConnection,
  type McpConnectionId,
  McpConnectionSummary,
  type McpServerInfo,
  type McpTool,
  type McpToolChoices
} from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

export interface McpConnectionRow {
  readonly id: string
  readonly owner_user_id: string
  readonly name: string
  readonly key: string
  readonly about: string
  readonly transport: "streamable-http" | "sse" | "stdio"
  readonly url: string | null
  readonly credential_id: string | null
  readonly header_names_json: string
  readonly headers_origin: string | null
  readonly proxy_mode: "inherit" | "direct" | "custom"
  readonly timeout_s: number
  readonly loading: "auto" | "immediate" | "deferred"
  readonly use_instructions: number
  readonly server_json: string | null
  readonly catalog_revision: number
  readonly listed_at: number | null
  readonly check_error: string | null
  readonly row_version: number
  readonly cache_revision: number
  readonly created_at: number
  readonly updated_at: number
  readonly tool_count: number
  readonly key_hint: string | null
  readonly credential_name: string | null
  readonly use_stories: number
  readonly use_workshops: number
  readonly use_tools_json: string
  readonly use_reviewed_revision: number
  readonly use_offered_key: string
  readonly use_oauth_origin: string | null
  readonly use_oauth_expires_at: number | null
  /** Only in full reads. */
  readonly tools_json?: string
}

const columns = `m.id, m.owner_user_id, m.name, m.key, m.about, m.transport, m.url, m.credential_id,
  m.header_names_json, m.headers_origin, m.proxy_mode, m.timeout_s, m.loading, m.use_instructions,
  m.server_json, m.catalog_revision, m.listed_at, m.check_error, m.row_version, m.cache_revision,
  m.created_at, m.updated_at, json_array_length(m.tools_json) AS tool_count,
  cr.key_hint AS key_hint, cr.name AS credential_name,
  u.stories AS use_stories, u.workshops AS use_workshops, u.tools_json AS use_tools_json,
  u.reviewed_revision AS use_reviewed_revision, u.offered_key AS use_offered_key,
  u.oauth_origin AS use_oauth_origin, u.oauth_expires_at AS use_oauth_expires_at`

/** The live connections a user can use, with their use; `?` is the user, twice. */
const from = `mcp_connections m
  JOIN mcp_uses u ON u.connection_id = m.id AND u.user_id = ?
  LEFT JOIN credentials cr ON cr.id = m.credential_id
  WHERE m.owner_user_id = ? AND m.deleted_at IS NULL AND m.purged_at IS NULL`

const fields = (row: McpConnectionRow) => ({
  id: row.id as McpConnectionId,
  name: row.name,
  key: row.key,
  about: row.about,
  transport: row.transport,
  url: row.url,
  hasKey: row.credential_id !== null,
  keyHint: row.key_hint ?? "",
  credentialId: row.credential_id as CredentialId | null,
  credentialName: row.credential_name,
  headerNames: JSON.parse(row.header_names_json) as Array<string>,
  headersOrigin: row.headers_origin,
  proxyMode: row.proxy_mode,
  timeoutS: row.timeout_s,
  loading: row.loading,
  useInstructions: row.use_instructions === 1,
  server: row.server_json === null ? null : (JSON.parse(row.server_json) as McpServerInfo),
  toolCount: row.tool_count,
  catalogRevision: row.catalog_revision,
  listedAt: row.listed_at,
  checkError: row.check_error,
  rowVersion: row.row_version,
  cacheRevision: row.cache_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  use: {
    stories: row.use_stories === 1,
    workshops: row.use_workshops === 1,
    tools: JSON.parse(row.use_tools_json) as McpToolChoices,
    reviewedRevision: row.use_reviewed_revision,
    offeredKey: row.use_offered_key,
    signIn: row.use_oauth_origin === null ? null : { origin: row.use_oauth_origin, expiresAt: row.use_oauth_expires_at }
  }
})

export const toMcpSummary = (row: McpConnectionRow) => new McpConnectionSummary(fields(row))
export const toMcpConnection = (row: McpConnectionRow) =>
  new McpConnection({ ...fields(row), tools: JSON.parse(row.tools_json ?? "[]") as Array<McpTool> })

export interface McpCallRow {
  readonly id: string
  readonly connection_id: string
  readonly method: McpCall["method"]
  readonly tool: string | null
  readonly purpose: McpCall["purpose"]
  readonly chat_id: string | null
  readonly rollout_id: string | null
  readonly tool_call_id: string | null
  readonly attempt: number
  readonly status: McpCall["status"]
  readonly started_at: number
  readonly ended_at: number | null
  readonly sent_bytes: number | null
  readonly received_bytes: number | null
  readonly error: string | null
}

export const toMcpCall = (row: McpCallRow) =>
  new McpCall({
    id: row.id,
    connectionId: row.connection_id as McpConnectionId,
    method: row.method,
    tool: row.tool,
    purpose: row.purpose,
    chatId: row.chat_id,
    rolloutId: row.rollout_id,
    toolCallId: row.tool_call_id,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sentBytes: row.sent_bytes,
    receivedBytes: row.received_bytes,
    error: row.error
  })

export const makeMcpQueries = (sql: SqlClient.SqlClient) => {
  const list = (userId: UserId) =>
    sql.unsafe<McpConnectionRow>(`SELECT ${columns} FROM ${from} ORDER BY m.created_at, m.id`, [userId, userId])
  /** A live connection the user can use, with its catalog, or NotFound. */
  const owned = (userId: UserId, connectionId: string) =>
    sql
      .unsafe<McpConnectionRow>(`SELECT ${columns}, m.tools_json FROM ${from} AND m.id = ?`, [
        userId,
        userId,
        connectionId
      ])
      .pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "mcp_connection", id: connectionId }))
        )
      )
  /** The live remote connections a user can use, with their catalogs, in creation order. */
  const catalogs = (userId: UserId) =>
    sql.unsafe<McpConnectionRow>(
      `SELECT ${columns}, m.tools_json FROM ${from} AND m.transport <> 'stdio' ORDER BY m.created_at, m.id`,
      [userId, userId]
    )
  return { list, owned, catalogs }
}
