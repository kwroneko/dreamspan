// What the MCP server screens read (spec/MCP.md §13.1). Writes name "mcp" to make these stale.
import type { McpCall, McpConnectionId, McpConnectionSummary } from "@rp/shared/mcp.ts"
import { AppClient } from "../../rpc.ts"

export const mcpConnectionsAtom = AppClient.query("ListMcpConnections", undefined, { reactivityKeys: ["mcp"] })

export const mcpConnectionAtom = (connectionId: McpConnectionId) =>
  AppClient.query("GetMcpConnection", { connectionId }, { reactivityKeys: ["mcp"] })

export const mcpCallsAtom = (connectionId: McpConnectionId) =>
  AppClient.query("ListMcpCalls", { connectionId, before: null }, { reactivityKeys: ["mcp"] })

export const credentialsAtom = AppClient.query("ListCredentials", undefined, { reactivityKeys: ["credentials"] })

/** The server's host as people read it: "api.example.com", or the address when it isn't a URL. */
export const mcpHost = (connection: Pick<McpConnectionSummary, "url" | "transport">) => {
  if (connection.transport === "stdio" || connection.url === null) return "Local program"
  try {
    return new URL(connection.url).host
  } catch {
    return connection.url
  }
}

/** The connection's state in a word, with a tone for its badge. */
export const mcpStatus = (
  connection: Pick<McpConnectionSummary, "checkError" | "listedAt">
): { readonly tone: "success" | "danger" | "neutral"; readonly label: string } =>
  connection.checkError !== null
    ? { tone: "danger", label: "Couldn't connect" }
    : connection.listedAt === null
      ? { tone: "neutral", label: "Not checked" }
      : { tone: "success", label: "Ready" }

export const transportLabels = {
  "streamable-http": "Streamable HTTP",
  sse: "SSE (older servers)",
  stdio: "Local program"
} as const

const callMethods: Record<McpCall["method"], string> = {
  initialize: "Connect",
  "tools/list": "List tools",
  "tools/call": "Call",
  oauth: "Sign-in"
}

/** What a ledger row was, as the Recent calls list says it. */
export const callLabel = (call: McpCall) =>
  call.method === "tools/call" && call.tool !== null ? call.tool : callMethods[call.method]

export const callStatusLabels: Record<McpCall["status"], string> = {
  running: "Running",
  complete: "Done",
  error: "The server answered with an error",
  failed: "Failed",
  timeout: "Timed out",
  cancelled: "Stopped",
  interrupted: "Interrupted by a restart"
}

/** "1.2 KB", "340 B". */
export const bytesLabel = (bytes: number | null) =>
  bytes === null
    ? "?"
    : bytes < 1000
      ? `${bytes} B`
      : bytes < 1_000_000
        ? `${(bytes / 1000).toFixed(1)} KB`
        : `${(bytes / 1_000_000).toFixed(1)} MB`

/** "1.2 s", "340 ms". */
export const durationLabel = (call: McpCall) =>
  call.endedAt === null
    ? "…"
    : call.endedAt - call.startedAt < 1000
      ? `${call.endedAt - call.startedAt} ms`
      : `${((call.endedAt - call.startedAt) / 1000).toFixed(1)} s`
