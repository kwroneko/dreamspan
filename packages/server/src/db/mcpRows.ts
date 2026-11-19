// MCP connection rows as the reads and writes see them (spec/MCP.md §12): one query shape for both
// workers, so a write returns exactly what a read would. A user sees the connections they own and
// those an admin shared with them (§3), each with their own use; a shared one's secrets and the
// path of its address read as empty.
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
  readonly command_json: string | null
  readonly env_names_json: string
  readonly share_scope: "private" | "all" | "chosen"
  readonly owner_name: string
  /** 1 when the reading user owns it. */
  readonly is_owner: number
  /** Only in full reads. */
  readonly tools_json?: string
  readonly share_users_json?: string
  readonly others_calls?: number
}

const columns = `m.id, m.owner_user_id, m.name, m.key, m.about, m.transport, m.url, m.credential_id,
  m.header_names_json, m.headers_origin, m.proxy_mode, m.timeout_s, m.loading, m.use_instructions,
  m.server_json, m.catalog_revision, m.listed_at, m.check_error, m.row_version, m.cache_revision,
  m.created_at, m.updated_at, json_array_length(m.tools_json) AS tool_count,
  cr.key_hint AS key_hint, cr.name AS credential_name,
  u.stories AS use_stories, u.workshops AS use_workshops, u.tools_json AS use_tools_json,
  u.reviewed_revision AS use_reviewed_revision, u.offered_key AS use_offered_key,
  u.oauth_origin AS use_oauth_origin, u.oauth_expires_at AS use_oauth_expires_at,
  m.command_json, m.env_names_json, m.share_scope, ow.display_name AS owner_name, (m.owner_user_id = u.user_id) AS is_owner`

/** What only full reads carry: the catalog, whom it's shared with, and others' calls. */
const fullColumns = `m.tools_json,
  (SELECT json_group_array(user_id) FROM (SELECT user_id FROM mcp_connection_shares
    WHERE connection_id = m.id ORDER BY created_at, user_id)) AS share_users_json,
  (SELECT count(*) FROM mcp_calls c WHERE c.connection_id = m.id AND c.owner_user_id <> m.owner_user_id) AS others_calls`

/**
 * Whether a user may use a connection: theirs, or shared with everyone or with them. `?` is the
 * user, twice.
 */
const mcpVisibleSql = `(m.owner_user_id = ? OR m.share_scope = 'all'
  OR (m.share_scope = 'chosen' AND EXISTS (SELECT 1 FROM mcp_connection_shares s
    WHERE s.connection_id = m.id AND s.user_id = ?)))`

/** The live connections a user can use, with their use; `?` is the user, three times. */
const from = `mcp_connections m
  JOIN mcp_uses u ON u.connection_id = m.id AND u.user_id = ?
  JOIN users ow ON ow.id = m.owner_user_id
  LEFT JOIN credentials cr ON cr.id = m.credential_id
  WHERE m.deleted_at IS NULL AND m.purged_at IS NULL AND ${mcpVisibleSql}`

/** A local program's stored argument list as the program and its arguments. */
const programOf = (json: string) => {
  const [command = "", ...args] = JSON.parse(json) as Array<string>
  return { command, args }
}

/** A shared connection's address as others see it: its origin, never the path or query. */
const originOnly = (url: string | null) => {
  try {
    return url === null ? null : new URL(url).origin
  } catch {
    return null
  }
}

/** The row as the reading user may see it; `reveal` (the main thread's client only) shows all. */
const fields = (row: McpConnectionRow, reveal: boolean) => {
  const mine = row.is_owner === 1 || reveal
  return {
    id: row.id as McpConnectionId,
    owned: row.is_owner === 1,
    ownerName: row.is_owner === 1 ? null : row.owner_name,
    name: row.name,
    key: row.key,
    about: row.about,
    transport: row.transport,
    url: mine ? row.url : originOnly(row.url),
    hasKey: mine && row.credential_id !== null,
    keyHint: mine ? (row.key_hint ?? "") : "",
    credentialId: mine ? (row.credential_id as CredentialId | null) : null,
    credentialName: mine ? row.credential_name : null,
    headerNames: mine ? (JSON.parse(row.header_names_json) as Array<string>) : [],
    headersOrigin: mine ? row.headers_origin : null,
    proxyMode: mine ? row.proxy_mode : ("inherit" as const),
    program: mine && row.command_json !== null ? programOf(row.command_json) : null,
    envNames: mine ? (JSON.parse(row.env_names_json) as Array<string>) : [],
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
      signIn:
        row.use_oauth_origin === null ? null : { origin: row.use_oauth_origin, expiresAt: row.use_oauth_expires_at }
    }
  }
}

export const toMcpSummary = (row: McpConnectionRow) => new McpConnectionSummary(fields(row, false))
export const toMcpConnection = (row: McpConnectionRow, reveal = false) =>
  new McpConnection({
    ...fields(row, reveal),
    tools: JSON.parse(row.tools_json ?? "[]") as Array<McpTool>,
    share:
      row.is_owner === 1
        ? { scope: row.share_scope, userIds: JSON.parse(row.share_users_json ?? "[]") as Array<UserId> }
        : { scope: "private", userIds: [] },
    othersCalls: row.is_owner === 1 ? (row.others_calls ?? 0) : 0
  })

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
  const users = (userId: UserId) => [userId, userId, userId]
  const list = (userId: UserId) =>
    sql.unsafe<McpConnectionRow>(`SELECT ${columns} FROM ${from} ORDER BY m.created_at, m.id`, users(userId))
  /** A live connection the user can use (their own or shared with them), with its catalog, or NotFound. */
  const owned = (userId: UserId, connectionId: string) =>
    sql
      .unsafe<McpConnectionRow>(`SELECT ${columns}, ${fullColumns} FROM ${from} AND m.id = ?`, [
        ...users(userId),
        connectionId
      ])
      .pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "mcp_connection", id: connectionId }))
        )
      )
  /** A live connection the user owns, or NotFound: only the owner changes how it's reached. */
  const mine = (userId: UserId, connectionId: string) =>
    owned(userId, connectionId).pipe(
      Effect.flatMap((row) =>
        row.is_owner === 1
          ? Effect.succeed(row)
          : Effect.fail(new NotFound({ entity: "mcp_connection", id: connectionId }))
      )
    )
  /**
   * The live connections a user can use, with their catalogs, in creation order. Local programs
   * included: where the instance doesn't run them, the agent's offer leaves them out.
   */
  const catalogs = (userId: UserId) =>
    sql.unsafe<McpConnectionRow>(
      `SELECT ${columns}, ${fullColumns} FROM ${from} ORDER BY m.created_at, m.id`,
      users(userId)
    )
  return { list, owned, mine, catalogs }
}
