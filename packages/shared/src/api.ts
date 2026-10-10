// The client-facing contract. Every UI action is an RPC in this group (DESIGN §7.7).
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { User } from "./domain.ts"
import { Forbidden, ModelKeyTaken, NotFound, ProviderError, ServerError, StaleWrite } from "./errors.ts"
import {
  Connection,
  ConnectionId,
  ConnectionSettings,
  Model,
  ModelId,
  ModelOverrides,
  ProviderKind,
  ProxyMode
} from "./providers.ts"
import { LlmRequest } from "./usage.ts"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}) {}

/** The authenticated user, provided to every handler by the `Authentication` middleware. */
export class CurrentUser extends Context.Service<CurrentUser, User>()("rp/CurrentUser") {}

export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "rp/Authentication",
  { error: Unauthorized }
) {}

export class Health extends Schema.Class<Health>("Health")({
  version: Schema.String,
  uptimeMs: Schema.Number,
  /** p99 event-loop delay on the server's main thread over the last sampling window. */
  eventLoopP99Ms: Schema.Number,
  readers: Schema.Int
}) {}

/** The result of checking a connection, with the route its request took. */
export class ConnectionTest extends Schema.Class<ConnectionTest>("ConnectionTest")({
  ok: Schema.Boolean,
  detail: Schema.String,
  route: Schema.NullOr(Schema.String),
  models: Schema.NullOr(Schema.Int)
}) {}

export class ModelRefresh extends Schema.Class<ModelRefresh>("ModelRefresh")({
  added: Schema.Int,
  updated: Schema.Int,
  missing: Schema.Int,
  route: Schema.NullOr(Schema.String)
}) {}

/** The instance's outbound network settings (spec/PROVIDERS.md §6.2). The proxy never shows credentials. */
export class NetworkSettings extends Schema.Class<NetworkSettings>("NetworkSettings")({
  proxy: Schema.NullOr(Schema.String),
  bypass: Schema.Array(Schema.String)
}) {}

export class InvalidNetworkSettings extends Schema.TaggedError<InvalidNetworkSettings>()("InvalidNetworkSettings", {
  problems: Schema.Array(Schema.String)
}) {}

const StorageErrors = [NotFound, ServerError] as const

export class AppApi extends RpcGroup.make(
  Rpc.make("Health", { success: Health }),
  Rpc.make("Whoami", { success: User }),
  // --- Connections and models (spec/PROVIDERS.md §2, §3). Keys go in, never out.
  Rpc.make("ListConnections", { success: Schema.Array(Connection), error: ServerError }),
  Rpc.make("CreateConnection", {
    payload: { kind: ProviderKind, settings: ConnectionSettings, apiKey: Schema.NullOr(Schema.String) },
    success: Connection,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("UpdateConnection", {
    payload: { connectionId: ConnectionId, settings: ConnectionSettings, expectedRowVersion: Schema.Int },
    success: Connection,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** Sets or clears the API key. Nothing returns it: only its last 4 characters show. */
  Rpc.make("SetConnectionKey", {
    payload: { connectionId: ConnectionId, apiKey: Schema.NullOr(Schema.String) },
    success: Connection,
    error: Schema.Union([ProviderError, ServerError])
  }),
  /** Replaces the custom headers. Only their names ever come back. */
  Rpc.make("SetConnectionHeaders", {
    payload: { connectionId: ConnectionId, headers: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) },
    success: Connection,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("SetConnectionProxy", {
    payload: { connectionId: ConnectionId, mode: ProxyMode, url: Schema.NullOr(Schema.String) },
    success: Connection,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("DeleteConnection", {
    payload: { connectionId: ConnectionId },
    success: BinItem,
    error: Schema.Union([...StorageErrors])
  }),
  Rpc.make("TestConnection", {
    payload: { connectionId: ConnectionId },
    success: ConnectionTest,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("RefreshModels", {
    payload: { connectionId: ConnectionId },
    success: ModelRefresh,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("ListModels", {
    payload: { connectionId: ConnectionId, includeHidden: Schema.Boolean },
    success: Schema.Array(Model),
    error: Schema.Union([...StorageErrors])
  }),
  Rpc.make("AddUserModel", {
    payload: { connectionId: ConnectionId, key: Schema.String, overrides: ModelOverrides },
    success: Model,
    error: Schema.Union([NotFound, ModelKeyTaken, ServerError])
  }),
  Rpc.make("EditModel", {
    payload: { modelId: ModelId, overrides: ModelOverrides, expectedRowVersion: Schema.Int },
    success: Model,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  Rpc.make("SetModelHidden", {
    payload: { modelId: ModelId, hidden: Schema.Boolean },
    success: Model,
    error: Schema.Union([...StorageErrors])
  }),
  // --- Instance network settings, admins only (PROVIDERS §6.2).
  Rpc.make("GetNetworkSettings", { success: NetworkSettings, error: Forbidden }),
  /** `proxyUrl` omitted keeps the stored proxy; null removes it. */
  Rpc.make("SetNetworkSettings", {
    payload: { proxyUrl: Schema.optionalKey(Schema.NullOr(Schema.String)), bypass: Schema.Array(Schema.String) },
    success: NetworkSettings,
    error: Schema.Union([Forbidden, InvalidNetworkSettings, ServerError])
  }),
  // --- Usage (PROVIDERS §9).
  Rpc.make("ListLlmRequests", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      /** The last row of the previous page; start times alone can tie. */
      before: Schema.NullOr(Schema.Struct({ startedAt: Schema.Number, id: Schema.String }))
    },
    success: Schema.Array(LlmRequest),
    error: ServerError
  })
).middleware(Authentication) {}
