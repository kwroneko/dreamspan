// The MCP server RPCs (spec/MCP.md §2, §10, §13.1), in a group of their own: AppCoreApi is at
// TypeScript's instantiation depth (TS2589). Every one is the user's own: the agent is never
// handed any of them (agent/exposures/exclusions.ts).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import {
  McpCall,
  McpCheck,
  McpConnection,
  McpConnectionId,
  McpConnectionSettings,
  McpConnectionSummary,
  McpLoading,
  McpRefused,
  McpShareScope,
  McpToolChoices
} from "./mcp.ts"
import { UserId } from "./domain.ts"
import { CredentialId, ProxyMode } from "./providers.ts"

/**
 * One server as a story chat's Tools offers it (spec/MCP.md §13.2): its name and host, how many of
 * its tools the user allowed, and the account's Stories switch, which a branch may override.
 */
export const StoryMcpServer = Schema.Struct({
  connectionId: McpConnectionId,
  name: Schema.String,
  host: Schema.String,
  allowedTools: Schema.Int,
  stories: Schema.Boolean
})
export type StoryMcpServer = typeof StoryMcpServer.Type

export class McpApi extends RpcGroup.make(
  /** The user's connections, oldest first (the order their tools are offered in). */
  Rpc.make("ListMcpConnections", { success: Schema.Array(McpConnectionSummary), error: ServerError }),
  /** The user's remote servers as a story chat's Tools lists them, oldest first. */
  Rpc.make("ListStoryMcpServers", { success: Schema.Array(StoryMcpServer), error: ServerError }),
  /** One connection with its tool catalog. */
  Rpc.make("GetMcpConnection", {
    payload: { connectionId: McpConnectionId },
    success: McpConnection,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * A new remote server. A typed key becomes a credential bound to its address. The app then
   * checks it once (initialize and the tool list, nothing of the user's), as the user asked.
   */
  Rpc.make("CreateMcpConnection", {
    payload: {
      settings: McpConnectionSettings,
      apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
      credentialId: Schema.optionalKey(Schema.NullOr(CredentialId))
    },
    success: Schema.Struct({ connection: McpConnection, check: McpCheck }),
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** A changed address or transport is checked again at once. */
  Rpc.make("UpdateMcpConnection", {
    payload: { connectionId: McpConnectionId, settings: McpConnectionSettings, expectedRowVersion: Schema.Int },
    success: Schema.Struct({ connection: McpConnection, check: Schema.NullOr(McpCheck) }),
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** A key typed for the connection, bound to its address; null for none. */
  Rpc.make("SetMcpKey", {
    payload: {
      connectionId: McpConnectionId,
      apiKey: Schema.NullOr(Schema.String),
      expectedRowVersion: Schema.Int
    },
    success: McpConnection,
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** A key saved in Settings → Keys, or none. */
  Rpc.make("SetMcpCredential", {
    payload: { connectionId: McpConnectionId, credentialId: Schema.NullOr(CredentialId) },
    success: McpConnection,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Header values, bound to the connection's address like a key; null removes them all. */
  Rpc.make("SetMcpHeaders", {
    payload: {
      connectionId: McpConnectionId,
      headers: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
      expectedRowVersion: Schema.Int
    },
    success: McpConnection,
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /**
   * A local program's environment variables (an admin's; replaces them all; null for none).
   * Values are encrypted and never shown again.
   */
  Rpc.make("SetMcpEnvironment", {
    payload: {
      connectionId: McpConnectionId,
      env: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
      expectedRowVersion: Schema.Int
    },
    success: McpConnection,
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** Whether this user may add local programs here, and if not, why (spec/MCP.md §2.2). */
  Rpc.make("GetMcpLocalPrograms", {
    success: Schema.Struct({ allowed: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
    error: ServerError
  }),
  /** What a local program wrote to stderr lately (the last 64 KiB), for the caller's own process. */
  Rpc.make("GetMcpProgramOutput", {
    payload: { connectionId: McpConnectionId },
    success: Schema.Struct({ running: Schema.Boolean, output: Schema.String }),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SetMcpProxy", {
    payload: { connectionId: McpConnectionId, mode: ProxyMode, url: Schema.NullOr(Schema.String) },
    success: McpConnection,
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** Connects to the server, asks for its tools, stores them and closes. Nothing from chats is sent. */
  Rpc.make("CheckMcpConnection", {
    payload: { connectionId: McpConnectionId },
    success: Schema.Struct({ connection: McpConnection, check: McpCheck }),
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /**
   * The user's own use of a connection: the account switches, and the tool allow list with the
   * catalog revision the page showed (tools listed after it stay off until chosen). Fields left
   * out stay as they are.
   */
  Rpc.make("SetMcpUse", {
    payload: {
      connectionId: McpConnectionId,
      stories: Schema.optionalKey(Schema.Boolean),
      workshops: Schema.optionalKey(Schema.Boolean),
      tools: Schema.optionalKey(Schema.Struct({ choices: McpToolChoices, reviewedRevision: Schema.Int }))
    },
    success: McpConnection,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * How the connection's tools reach the model: "Send its tools" and "Use the server's
   * instructions" (spec/MCP.md §4.4). Fields left out stay as they are. Nothing is sent to it.
   */
  Rpc.make("SetMcpLoading", {
    payload: {
      connectionId: McpConnectionId,
      loading: Schema.optionalKey(McpLoading),
      useInstructions: Schema.optionalKey(Schema.Boolean)
    },
    success: McpConnection,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Starts signing in with the server (spec/MCP.md §2.4): finds its sign-in service, registers
   * the app there if needed, and returns the page to open. `appOrigin` is the address the browser
   * uses for the app; the sign-in page sends the browser back to it. Nothing of the user's is sent.
   */
  Rpc.make("StartMcpSignIn", {
    payload: { connectionId: McpConnectionId, appOrigin: Schema.String },
    success: Schema.Struct({ authorizationUrl: Schema.String }),
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /**
   * The sign-in page sent the browser back (its `state`, and a `code` or an `error`): the app
   * exchanges the code for the user's own tokens and keeps them, encrypted, on their use.
   */
  Rpc.make("FinishMcpSignIn", {
    payload: { state: Schema.String, code: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) },
    success: Schema.Struct({ connectionId: McpConnectionId, name: Schema.String }),
    error: Schema.Union([McpRefused, NotFound, StaleWrite, ServerError])
  }),
  /** Forgets the user's own sign-in with the server. Nothing is sent to it. */
  Rpc.make("SignOutOfMcp", {
    payload: { connectionId: McpConnectionId },
    success: McpConnection,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /**
   * An admin shares their server (spec/MCP.md §3): with nobody, everyone, or the users chosen.
   * Those who lose it lose their own use of it, their sign-in included.
   */
  Rpc.make("SetMcpShare", {
    payload: { connectionId: McpConnectionId, scope: McpShareScope, userIds: Schema.Array(UserId) },
    success: McpConnection,
    error: Schema.Union([McpRefused, NotFound, ServerError])
  }),
  Rpc.make("DeleteMcpConnection", {
    payload: { connectionId: McpConnectionId },
    success: BinItem,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The requests sent to a connection, newest first, a page at a time. */
  Rpc.make("ListMcpCalls", {
    payload: {
      connectionId: McpConnectionId,
      before: Schema.NullOr(Schema.Struct({ startedAt: Schema.Number, id: Schema.String }))
    },
    success: Schema.Array(McpCall),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
