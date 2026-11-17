// The MCP server RPCs (McpApi, spec/MCP.md §13.1): the user's own connections, their secrets,
// Check, the allow list and the call ledger. Every one acts as the signed-in user on what they own.
import { CurrentUser } from "@rp/shared/api.ts"
import { MCP_CALLS_PAGE } from "@rp/shared/mcp.ts"
import type { McpApi } from "@rp/shared/mcpApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { McpConnections } from "../mcp/McpConnections.ts"
import { internal } from "./internal.ts"

export const makeMcpHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const mcp = yield* McpConnections
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    ListMcpConnections: () =>
      Effect.flatMap(userId, (id) => reader.ListMcpConnections({ userId: id })).pipe(internal("ListMcpConnections")),
    GetMcpConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => reader.GetMcpConnection({ userId: id, connectionId })).pipe(
        internal("GetMcpConnection")
      ),
    CreateMcpConnection: ({ settings, apiKey, credentialId }) =>
      Effect.flatMap(userId, (id) =>
        mcp.create({ userId: id, settings, apiKey: apiKey ?? null, credentialId: credentialId ?? null })
      ).pipe(internal("CreateMcpConnection")),
    UpdateMcpConnection: ({ connectionId, settings, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => mcp.update(id, connectionId, settings, expectedRowVersion)).pipe(
        internal("UpdateMcpConnection")
      ),
    SetMcpKey: ({ connectionId, apiKey, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => mcp.setKey(id, connectionId, apiKey, expectedRowVersion)).pipe(
        internal("SetMcpKey")
      ),
    SetMcpCredential: ({ connectionId, credentialId }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetMcpCredential({ userId: id, connectionId, credentialId, at: Date.now() })
      ).pipe(internal("SetMcpCredential")),
    SetMcpHeaders: ({ connectionId, headers, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => mcp.setHeaders(id, connectionId, headers, expectedRowVersion)).pipe(
        internal("SetMcpHeaders")
      ),
    SetMcpProxy: ({ connectionId, mode, url }) =>
      Effect.flatMap(userId, (id) => mcp.setProxy(id, connectionId, mode, url)).pipe(internal("SetMcpProxy")),
    CheckMcpConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => mcp.check(id, connectionId)).pipe(internal("CheckMcpConnection")),
    SetMcpUse: ({ connectionId, stories, workshops, tools }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetMcpUse({
          userId: id,
          connectionId,
          ...(stories === undefined ? {} : { stories }),
          ...(workshops === undefined ? {} : { workshops }),
          ...(tools === undefined ? {} : { tools }),
          at: Date.now()
        })
      ).pipe(internal("SetMcpUse")),
    DeleteMcpConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => writer.DeleteMcpConnection({ userId: id, connectionId })).pipe(
        internal("DeleteMcpConnection")
      ),
    ListMcpCalls: ({ connectionId, before }) =>
      Effect.flatMap(userId, (id) =>
        reader.ListMcpCalls({ userId: id, connectionId, before, limit: MCP_CALLS_PAGE })
      ).pipe(internal("ListMcpCalls"))
  } satisfies Parameters<typeof McpApi.of>[0]
})
