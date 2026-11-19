// The MCP server RPCs (McpApi, spec/MCP.md §13.1): the user's own connections, their secrets,
// Check, the allow list and the call ledger. Every one acts as the signed-in user on what they own.
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { MCP_CALLS_PAGE, McpRefused } from "@dreamspan/shared/mcp.ts"
import type { McpApi } from "@dreamspan/shared/mcpApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { McpConnections } from "../mcp/McpConnections.ts"
import { allowedToolCount, mcpHostOf } from "../agent/tools/mcp.ts"
import { internal } from "./internal.ts"

export const makeMcpHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const mcp = yield* McpConnections
  const userId = Effect.map(CurrentUser, (user) => user.id)
  /**
   * A local program runs code on the server (spec/MCP.md §2.2): only an admin adds or changes
   * one, only where the instance allows it. Database triggers refuse non-admins too.
   */
  const localProgramGate = (transport: string) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      if (transport !== "stdio") return user
      const gate = yield* mcp.localProgramsFor(user.role)
      if (!gate.allowed) return yield* new McpRefused({ message: gate.reason ?? "Local programs can't run here." })
      return user
    })
  return {
    ListMcpConnections: () =>
      Effect.flatMap(userId, (id) => reader.ListMcpConnections({ userId: id })).pipe(internal("ListMcpConnections")),
    ListStoryMcpServers: () =>
      Effect.flatMap(userId, (id) => reader.McpStoryConnections({ userId: id })).pipe(
        Effect.map((connections) =>
          connections.map((connection) => ({
            connectionId: connection.id,
            name: connection.name,
            host: mcpHostOf(connection),
            allowedTools: allowedToolCount(connection),
            stories: connection.use.stories
          }))
        ),
        internal("ListStoryMcpServers")
      ),
    GetMcpConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => reader.GetMcpConnection({ userId: id, connectionId })).pipe(
        internal("GetMcpConnection")
      ),
    CreateMcpConnection: ({ settings, apiKey, credentialId }) =>
      Effect.gen(function* () {
        const user = yield* localProgramGate(settings.transport)
        return yield* mcp.create({
          userId: user.id,
          settings,
          apiKey: apiKey ?? null,
          credentialId: credentialId ?? null
        })
      }).pipe(internal("CreateMcpConnection")),
    UpdateMcpConnection: ({ connectionId, settings, expectedRowVersion }) =>
      Effect.gen(function* () {
        const user = yield* localProgramGate(settings.transport)
        return yield* mcp.update(user.id, connectionId, settings, expectedRowVersion)
      }).pipe(internal("UpdateMcpConnection")),
    SetMcpEnvironment: ({ connectionId, env, expectedRowVersion }) =>
      Effect.gen(function* () {
        const user = yield* localProgramGate("stdio")
        return yield* mcp.setEnvironment(user.id, connectionId, env, expectedRowVersion)
      }).pipe(internal("SetMcpEnvironment")),
    GetMcpLocalPrograms: () =>
      Effect.flatMap(CurrentUser, (user) => mcp.localProgramsFor(user.role)).pipe(internal("GetMcpLocalPrograms")),
    GetMcpProgramOutput: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => mcp.programOutput(id, connectionId)).pipe(internal("GetMcpProgramOutput")),
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
    SetMcpLoading: ({ connectionId, loading, useInstructions }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetMcpLoading({
          userId: id,
          connectionId,
          ...(loading === undefined ? {} : { loading }),
          ...(useInstructions === undefined ? {} : { useInstructions }),
          at: Date.now()
        })
      ).pipe(internal("SetMcpLoading")),
    StartMcpSignIn: ({ connectionId, appOrigin }) =>
      Effect.flatMap(userId, (id) => mcp.startSignIn(id, connectionId, appOrigin)).pipe(internal("StartMcpSignIn")),
    FinishMcpSignIn: ({ state, code, error }) =>
      Effect.flatMap(userId, (id) => mcp.finishSignIn(id, state, code, error)).pipe(internal("FinishMcpSignIn")),
    SignOutOfMcp: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => mcp.signOut(id, connectionId)).pipe(internal("SignOutOfMcp")),
    SetMcpShare: ({ connectionId, scope, userIds }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        // Only an admin shares (a trigger refuses anyone else too).
        if (user.role !== "admin")
          return yield* new McpRefused({ message: "Only an admin can share a server with others." })
        const connection = yield* writer.SetMcpShare({
          userId: user.id,
          connectionId,
          scope,
          userIds,
          at: Date.now()
        })
        // Those who lost it have no session left with it.
        yield* mcp.closeKept(connectionId)
        return connection
      }).pipe(internal("SetMcpShare")),
    DeleteMcpConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => writer.DeleteMcpConnection({ userId: id, connectionId })).pipe(
        Effect.tap(() => mcp.closeKept(connectionId)),
        internal("DeleteMcpConnection")
      ),
    ListMcpCalls: ({ connectionId, before }) =>
      Effect.flatMap(userId, (id) =>
        reader.ListMcpCalls({ userId: id, connectionId, before, limit: MCP_CALLS_PAGE })
      ).pipe(internal("ListMcpCalls"))
  } satisfies Parameters<typeof McpApi.of>[0]
})
