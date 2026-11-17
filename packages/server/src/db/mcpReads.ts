// MCP connection and ledger reads (spec/MCP.md §12), in the reader workers.
import type { CredentialId } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type McpCallRow, makeMcpQueries, toMcpCall, toMcpConnection, toMcpSummary } from "./mcpRows.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeMcpReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { list, owned } = makeMcpQueries(sql)
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
        }>`SELECT m.headers_enc, m.proxy_url_enc, u.role FROM mcp_connections m JOIN users u ON u.id = m.owner_user_id
          WHERE m.id = ${connectionId}`
        const [credential] =
          row.credential_id === null
            ? []
            : yield* sql<{ id: string; key_enc: Uint8Array; origins_json: string }>`
                SELECT id, key_enc, origins_json FROM credentials WHERE id = ${row.credential_id}`
        return {
          connection: toMcpConnection(row),
          credential: credential
            ? {
                id: credential.id as CredentialId,
                keyEnc: credential.key_enc,
                origins: JSON.parse(credential.origins_json) as Array<string>
              }
            : null,
          headersEnc: secrets!.headers_enc,
          proxyUrlEnc: secrets!.proxy_url_enc,
          ownerRole: secrets!.role
        }
      }).pipe(query("ResolveMcpConnection")),
    ListMcpCalls: ({ userId, connectionId, before, limit }) =>
      Effect.gen(function* () {
        // The calls of a connection the user can see, binned or not, but only their own.
        const [connection] = yield* sql`SELECT 1 FROM mcp_connections
          WHERE id = ${connectionId} AND owner_user_id = ${userId} AND purged_at IS NULL`
        if (!connection) return yield* new NotFound({ entity: "mcp_connection", id: connectionId })
        const at = before?.startedAt ?? Number.MAX_SAFE_INTEGER
        const rows = yield* sql<McpCallRow>`SELECT * FROM mcp_calls
          WHERE connection_id = ${connectionId} AND owner_user_id = ${userId}
            AND (started_at < ${at} OR (started_at = ${at} AND id < ${before?.id ?? ""}))
          ORDER BY started_at DESC, id DESC LIMIT ${limit}`
        return rows.map(toMcpCall)
      }).pipe(query("ListMcpCalls"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
