// MCP servers (spec/MCP.md): the connections a user adds in Settings → MCP servers, the catalog
// of tools the app stored when it last listed one, each user's use of it, and the ledger of every
// request the app sent to one. Shared by the server, its workers and the client.
import { Schema } from "effect"
import { idSchema } from "./id.ts"
import { CredentialId, ProxyMode } from "./providers.ts"

export const McpConnectionId = idSchema("McpConnectionId", "mcp_connection")
export type McpConnectionId = typeof McpConnectionId.Type

/** "stdio" exists in storage for local programs (M6); nothing creates one yet. */
const McpTransport = Schema.Literals(["streamable-http", "sse", "stdio"])
/** The transports a remote server is reached by. */
export const RemoteMcpTransport = Schema.Literals(["streamable-http", "sse"])
export type RemoteMcpTransport = typeof RemoteMcpTransport.Type

const McpLoading = Schema.Literals(["auto", "immediate", "deferred"])

/** The shortest and longest timeout a connection may set, in seconds (spec/MCP.md §7.3). */
export const MCP_TIMEOUT_MIN_S = 5
export const MCP_TIMEOUT_MAX_S = 1800
export const MCP_TIMEOUT_DEFAULT_S = 60

/** A tool's description is cut here for the model (the page says so). */
export const MCP_DESCRIPTION_LIMIT = 4000
/** A tool whose parameters' JSON is larger than this can't be used. */
export const MCP_SCHEMA_LIMIT = 64 * 1024
/** A listing stops here: the first this many tools, at most this many bytes. */
export const MCP_TOOLS_LIMIT = 1000
export const MCP_LISTING_BYTES_LIMIT = 2 * 1024 * 1024
/** The longest a model-facing tool name may be (OpenAI's function-name limit, the strictest wire). */
export const MCP_TOOL_NAME_LIMIT = 64
/** Recent calls on a connection's page, per page. */
export const MCP_CALLS_PAGE = 50

/** One tool of a server's listing, as stored in the catalog (spec/MCP.md §4.1). */
export const McpTool = Schema.Struct({
  /** The server's own name for it, sent back in `tools/call`. */
  name: Schema.String,
  /** What the model sees: `mcp_<key>_<tool>`, fitted to 64 characters, fixed while `name` is. */
  exposed: Schema.String,
  title: Schema.NullOr(Schema.String),
  /** The server's description, whole. The model is sent at most MCP_DESCRIPTION_LIMIT characters. */
  description: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.NullOr(Schema.Unknown),
  /** What the server says about the tool (`readOnlyHint` and the rest): shown, never acted on. */
  annotations: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  /** The catalog revision it was first listed in: tools listed after the user last looked start off. */
  firstRevision: Schema.Int,
  /** Why it can't be used (its parameters aren't a valid object schema, say); null when it can. */
  problem: Schema.NullOr(Schema.String)
})
export type McpTool = typeof McpTool.Type

/** What the server said about itself when the app last listed it. */
export const McpServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  version: Schema.String,
  protocolVersion: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
  /** The listing stopped at MCP_TOOLS_LIMIT tools or MCP_LISTING_BYTES_LIMIT bytes. */
  truncated: Schema.Boolean
})
export type McpServerInfo = typeof McpServerInfo.Type

/** One user's choice for one tool: allowed or not, in every use. */
const McpToolChoice = Schema.Struct({ on: Schema.Boolean })
export const McpToolChoices = Schema.Record(Schema.String, McpToolChoice)
export type McpToolChoices = typeof McpToolChoices.Type

/** One user's use of a connection (spec/MCP.md §5): the account defaults and the allow list. */
export const McpUse = Schema.Struct({
  stories: Schema.Boolean,
  workshops: Schema.Boolean,
  tools: McpToolChoices,
  /** The catalog revision the user last saw on the page: tools first listed after it start off. */
  reviewedRevision: Schema.Int,
  /** The key this user's tools are offered under (the connection's, unless two collide). */
  offeredKey: Schema.String
})
export type McpUse = typeof McpUse.Type

const connectionFields = {
  id: McpConnectionId,
  name: Schema.String,
  /** Fixed at creation: the model sees the tools as `mcp_<key>_<tool>`. */
  key: Schema.String,
  /** The user's own words for what it's for. */
  about: Schema.String,
  transport: McpTransport,
  url: Schema.NullOr(Schema.String),
  hasKey: Schema.Boolean,
  keyHint: Schema.String,
  credentialId: Schema.NullOr(CredentialId),
  credentialName: Schema.NullOr(Schema.String),
  /** Header names only: values are never shown again. */
  headerNames: Schema.Array(Schema.String),
  /** The origin the header values were set for; null without headers. */
  headersOrigin: Schema.NullOr(Schema.String),
  proxyMode: ProxyMode,
  timeoutS: Schema.Int,
  loading: McpLoading,
  useInstructions: Schema.Boolean,
  server: Schema.NullOr(McpServerInfo),
  toolCount: Schema.Int,
  catalogRevision: Schema.Int,
  listedAt: Schema.NullOr(Schema.Number),
  checkError: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  cacheRevision: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  use: McpUse
}

/** A connection as its list shows it: everything but the tools. */
export class McpConnectionSummary extends Schema.Class<McpConnectionSummary>("McpConnectionSummary")(
  connectionFields
) {}

/** A connection with its catalog. Secrets appear only as `hasKey`, `keyHint` and header names. */
export class McpConnection extends Schema.Class<McpConnection>("McpConnection")({
  ...connectionFields,
  tools: Schema.Array(McpTool)
}) {}

/** What a new connection or a changed one is made of; secrets travel apart. */
export const McpConnectionSettings = Schema.Struct({
  name: Schema.String,
  about: Schema.String,
  transport: RemoteMcpTransport,
  url: Schema.String,
  timeoutS: Schema.Int
})
export type McpConnectionSettings = typeof McpConnectionSettings.Type

export const McpCallMethod = Schema.Literals(["initialize", "tools/list", "tools/call", "oauth"])
export const McpCallPurpose = Schema.Literals(["story", "workshop", "check"])
export const McpCallStatus = Schema.Literals([
  "running",
  "complete",
  "error",
  "failed",
  "timeout",
  "cancelled",
  "interrupted"
])
export type McpCallStatus = typeof McpCallStatus.Type

/** One request the app sent to a server (spec/MCP.md §10), with no arguments or results. */
export class McpCall extends Schema.Class<McpCall>("McpCall")({
  id: Schema.String,
  connectionId: McpConnectionId,
  method: McpCallMethod,
  tool: Schema.NullOr(Schema.String),
  purpose: McpCallPurpose,
  chatId: Schema.NullOr(Schema.String),
  rolloutId: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  status: McpCallStatus,
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  sentBytes: Schema.NullOr(Schema.Int),
  receivedBytes: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String)
}) {}

/** What Check found. */
export class McpCheck extends Schema.Class<McpCheck>("McpCheck")({
  ok: Schema.Boolean,
  detail: Schema.String,
  toolCount: Schema.NullOr(Schema.Int),
  /** How the requests went: "direct", or through which proxy. */
  route: Schema.NullOr(Schema.String),
  /** The other transport answered when this one didn't: the user may switch to it. */
  alternative: Schema.NullOr(RemoteMcpTransport)
}) {}

/** A connection change the app refused, with what to do about it. */
export class McpRefused extends Schema.TaggedError<McpRefused>()("McpRefused", {
  message: Schema.String
}) {}

/**
 * The key a new connection gets from its name (spec/MCP.md §4.2): lowercase letters and digits,
 * starting with a letter, at most 24 characters, "mcp" when nothing is left, and a number added
 * when the user already has it.
 */
export const mcpKeyFor = (name: string, taken: ReadonlySet<string>): string => {
  const letters = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
  const base = (letters === "" ? "mcp" : letters).slice(0, 24)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = String(n)
    const key = `${base.slice(0, 24 - suffix.length)}${suffix}`
    if (!taken.has(key)) return key
  }
}

/**
 * Whether a tool of the catalog is allowed: the user's own choice, else on when it was listed at
 * or before the revision the user last reviewed (tools added later start off, spec/MCP.md §4.1).
 */
export const mcpToolAllowed = (tool: McpTool, use: McpUse) =>
  tool.problem === null && (use.tools[tool.name]?.on ?? tool.firstRevision <= use.reviewedRevision)

/** A tool the server listed after the user last looked, with no choice of the user's yet. */
export const mcpToolIsNew = (tool: McpTool, use: McpUse) =>
  use.tools[tool.name] === undefined && tool.firstRevision > use.reviewedRevision

/** What the server's annotations say, as plain words; information only. */
export const mcpAnnotationNotes = (annotations: McpTool["annotations"]): ReadonlyArray<string> => {
  if (annotations === null) return []
  const notes: Array<string> = []
  if (annotations.readOnlyHint === true) notes.push("The server says it only reads")
  else if (annotations.destructiveHint === true) notes.push("The server says it may delete or overwrite things")
  if (annotations.readOnlyHint !== true && annotations.idempotentHint === true)
    notes.push("The server says calling it again changes nothing more")
  if (annotations.openWorldHint === true) notes.push("The server says it reaches other services")
  return notes
}
