// MCP connection and ledger reads (spec/MCP.md §12), in the reader workers.
import type { CredentialId } from "@dreamspan/shared/providers.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type McpCallRow, makeMcpQueries, toMcpCall, toMcpConnection, toMcpSummary } from "./mcpRows.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeMcpReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { list, owned, catalogs } = makeMcpQueries(sql)
  const handlers = {
    ListMcpConnections: ({ userId }) =>
      list(userId).pipe(
        Effect.map((rows) => rows.map(toMcpSummary)),
        query("ListMcpConnections")
      ),
    GetMcpConnection: ({ userId, connectionId }) =>
      owned(userId, connectionId).pipe(Effect.map(toMcpConnection), query("GetMcpConnection")),
    ResolveMcpConnection: ({ userId, connectionId }) =>
      Effect.gen(function* () {
        const row = yield* owned(userId, connectionId)
        const [secrets] = yield* sql<{
          headers_enc: Uint8Array | null
          proxy_url_enc: Uint8Array | null
          role: "admin" | "user"
          oauth_enc: Uint8Array | null
        }>`SELECT m.headers_enc, m.proxy_url_enc, u.role, s.oauth_enc
          FROM mcp_connections m JOIN users u ON u.id = m.owner_user_id
          LEFT JOIN mcp_uses s ON s.connection_id = m.id AND s.user_id = ${userId}
          WHERE m.id = ${connectionId}`
        const [credential] =
          row.credential_id === null
            ? []
            : yield* sql<{ id: string; key_enc: Uint8Array; origins_json: string }>`
                SELECT id, key_enc, origins_json FROM credentials WHERE id = ${row.credential_id}`
        return {
          // Everything about it, for the client that reaches it: never sent to a browser.
          connection: toMcpConnection(row, true),
          credential: credential
            ? {
                id: credential.id as CredentialId,
                keyEnc: credential.key_enc,
                origins: JSON.parse(credential.origins_json) as Array<string>
              }
            : null,
          headersEnc: secrets!.headers_enc,
          proxyUrlEnc: secrets!.proxy_url_enc,
          ownerRole: secrets!.role,
          oauthEnc: secrets!.oauth_enc
        }
      }).pipe(query("ResolveMcpConnection")),
    ListMcpCalls: ({ userId, connectionId, before, limit }) =>
      Effect.gen(function* () {
        // The calls of a connection the user has a use of (theirs, or one shared with them),
        // binned or not, but only their own: an admin sees others' only as a count.
        const [connection] = yield* sql`SELECT 1 FROM mcp_connections m
          JOIN mcp_uses u ON u.connection_id = m.id AND u.user_id = ${userId}
          WHERE m.id = ${connectionId} AND m.purged_at IS NULL`
        if (!connection) return yield* new NotFound({ entity: "mcp_connection", id: connectionId })
        const at = before?.startedAt ?? Number.MAX_SAFE_INTEGER
        const rows = yield* sql<McpCallRow>`SELECT * FROM mcp_calls
          WHERE connection_id = ${connectionId} AND owner_user_id = ${userId}
            AND (started_at < ${at} OR (started_at = ${at} AND id < ${before?.id ?? ""}))
          ORDER BY started_at DESC, id DESC LIMIT ${limit}`
        return rows.map(toMcpCall)
      }).pipe(query("ListMcpCalls")),
    McpStoryConnections: ({ userId }) =>
      catalogs(userId).pipe(
        Effect.map((rows) => rows.map((row) => toMcpConnection(row))),
        query("McpStoryConnections")
      ),
    McpWorkshopConnections: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const rows = yield* catalogs(userId)
        const grants = yield* sql<{ target: string; mode: "off" | "ask" | "allow" }>`SELECT target, mode
          FROM workshop_grants WHERE chat_id = ${chatId} AND owner_user_id = ${userId} AND capability = 'mcp'
            AND target <> '' AND (expires_at IS NULL OR expires_at > ${Date.now()})`
        const chosen = new Map(grants.map((g) => [g.target, g.mode]))
        return rows.map((row) => ({ connection: toMcpConnection(row), grant: chosen.get(row.id) ?? null }))
      }).pipe(query("McpWorkshopConnections")),
    McpCallsFor: ({ userId, rolloutId, toolCallId }) =>
      // A resumed run's version names the one it carries on (origin `resumed`, as approvals find
      // theirs, db/workshopGrants.ts): the call may have been sent by any run of that line.
      sql<McpCallRow>`WITH RECURSIVE line(id, depth) AS (
          SELECT ${rolloutId}, 0
          UNION SELECT src.rollout_id, line.depth + 1 FROM line
            JOIN versions v ON v.rollout_id = line.id AND v.origin = 'resumed' AND v.source_version_id IS NOT NULL
            JOIN versions src ON src.id = v.source_version_id
            WHERE src.rollout_id IS NOT NULL AND line.depth < 64
        )
        SELECT DISTINCT c.* FROM mcp_calls c JOIN line ON c.rollout_id = line.id
        WHERE c.owner_user_id = ${userId} AND c.tool_call_id = ${toolCallId} AND c.method = 'tools/call'
        ORDER BY c.started_at, c.id`.pipe(
        Effect.map((rows) => rows.map(toMcpCall)),
        query("McpCallsFor")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
