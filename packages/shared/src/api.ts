// The client-facing contract. Every UI action is an RPC in this group (DESIGN §7.7).
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { ChatApi } from "./chatApi.ts"
import { ChatSetupApi } from "./chatSetupApi.ts"
import { StImportApi } from "./stImportApi.ts"
import { User, UserAccount, UserId, UserRole } from "./domain.ts"
import { EditorApi } from "./editorApi.ts"
import {
  AccountRejected,
  Forbidden,
  ModelKeyTaken,
  NotFound,
  ProviderError,
  ServerError,
  StaleWrite
} from "./errors.ts"
import {
  Connection,
  ConnectionId,
  ConnectionSettings,
  Credential,
  CredentialId,
  Model,
  ModelId,
  ModelOverrides,
  ProviderKind,
  ProviderKindInfo,
  ProxyMode
} from "./providers.ts"
import { LlmRequest } from "./usage.ts"
import { EntityKind, LibraryRef } from "./library.ts"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}) {}

/** The authenticated user, provided to every handler by the `Authentication` middleware. */
export class CurrentUser extends Context.Service<CurrentUser, User>()("rp/CurrentUser") {}

export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "rp/Authentication",
  { error: Unauthorized }
) {}

/**
 * How the caller is signed in (DESIGN §10.1). `session`: logged in, so logging out applies.
 * `local`: no account has a password, so loopback and ALLOWED_IPS are the local admin
 * without logging in. `loopback`: LOOPBACK_REQUIRES_LOGIN is off. `proxy`: the reverse proxy
 * names the user, and signs them out.
 */
const SessionVia = Schema.Literals(["session", "local", "loopback", "proxy"])

export class Session extends Schema.Class<Session>("Session")({
  user: User,
  via: SessionVia
}) {}

export class Health extends Schema.Class<Health>("Health")({
  version: Schema.String,
  uptimeMs: Schema.Number,
  /** Event-loop delay on the server's main thread over the last minute: the worst one-second p99. */
  eventLoopP99Ms: Schema.Number,
  /** The longest single event-loop delay over the last minute. */
  eventLoopMaxMs: Schema.Number,
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
  bypass: Schema.Array(Schema.String),
  /** Non-admins' connections can't go direct or through their own proxy. */
  forceProxy: Schema.Boolean
}) {}

export class InvalidNetworkSettings extends Schema.TaggedError<InvalidNetworkSettings>()("InvalidNetworkSettings", {
  problems: Schema.Array(Schema.String)
}) {}

const StorageErrors = [NotFound, ServerError] as const

export class AppApi extends RpcGroup.make(
  Rpc.make("Health", { success: Health }),
  Rpc.make("Whoami", { success: User }),
  /** The caller's user and how they're signed in, so the client knows whether login applies. */
  Rpc.make("GetSession", { success: Session, error: Unauthorized }),
  // --- Accounts (DESIGN §10.1). No sign-up: an admin creates accounts. Login and logout
  // are HTTP (POST /auth/login, /auth/logout), since they set a cookie.
  Rpc.make("ListUsers", { success: Schema.Array(UserAccount), error: Schema.Union([Forbidden, ServerError]) }),
  Rpc.make("CreateUser", {
    payload: { handle: Schema.String, displayName: Schema.String, role: UserRole, password: Schema.String },
    success: UserAccount,
    error: Schema.Union([Forbidden, AccountRejected, ServerError])
  }),
  /**
   * Your own password, with the current one if you have one; an admin can set anyone's.
   * Ends every session of that user, the caller's included: log in again with the new one.
   */
  Rpc.make("SetPassword", {
    payload: { userId: UserId, currentPassword: Schema.NullOr(Schema.String), newPassword: Schema.String },
    success: Schema.Void,
    error: Schema.Union([Forbidden, NotFound, AccountRejected, ServerError])
  }),
  /** Disabling ends the user's sessions. The last enabled admin can't be disabled. */
  Rpc.make("SetUserDisabled", {
    payload: { userId: UserId, disabled: Schema.Boolean },
    success: UserAccount,
    error: Schema.Union([Forbidden, NotFound, AccountRejected, ServerError])
  }),
  // --- Connections and models (spec/PROVIDERS.md §2, §3). Keys go in, never out.
  /** The provider kinds a connection can use, built-in and from plugins, in picker order. */
  Rpc.make("ListProviderKinds", { success: Schema.Array(ProviderKindInfo) }),
  Rpc.make("ListConnections", { success: Schema.Array(Connection), error: ServerError }),
  /**
   * Uses an existing credential, or a key typed for it, which becomes a credential named
   * after the connection and bound to its host.
   */
  Rpc.make("CreateConnection", {
    payload: {
      kind: ProviderKind,
      settings: ConnectionSettings,
      apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
      credentialId: Schema.optionalKey(Schema.NullOr(CredentialId))
    },
    success: Connection,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("UpdateConnection", {
    payload: { connectionId: ConnectionId, settings: ConnectionSettings, expectedRowVersion: Schema.Int },
    success: Connection,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /**
   * A key typed for a connection: a new credential bound to its host, or null for no key.
   * Nothing returns a key: only its last 4 characters show.
   */
  Rpc.make("SetConnectionKey", {
    /** The row version is the connection the user saw: the key is bound to its base URL. */
    payload: { connectionId: ConnectionId, apiKey: Schema.NullOr(Schema.String), expectedRowVersion: Schema.Int },
    success: Connection,
    error: Schema.Union([ProviderError, StaleWrite, ServerError])
  }),
  /** Replaces the custom headers. Only their names ever come back. */
  Rpc.make("SetConnectionCredential", {
    payload: { connectionId: ConnectionId, credentialId: Schema.NullOr(CredentialId) },
    success: Connection,
    error: Schema.Union([NotFound, ServerError])
  }),
  // --- Credentials (spec/PROVIDERS.md §5): keys stored once, sent only to their hosts.
  Rpc.make("ListCredentials", { success: Schema.Array(Credential), error: ServerError }),
  Rpc.make("CreateCredential", {
    payload: { name: Schema.String, apiKey: Schema.String, urls: Schema.Array(Schema.String) },
    success: Credential,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("RenameCredential", {
    payload: { credentialId: CredentialId, name: Schema.String },
    success: Credential,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** A new key, with the hosts it may go to stated again: approvals for the old key don't carry over. */
  Rpc.make("ReplaceCredentialKey", {
    payload: { credentialId: CredentialId, apiKey: Schema.String, urls: Schema.Array(Schema.String) },
    success: Credential,
    error: Schema.Union([ProviderError, ServerError])
  }),
  /** Lets a key be sent to another host. Takes the key typed again. */
  Rpc.make("AllowCredentialHost", {
    payload: { credentialId: CredentialId, apiKey: Schema.String, url: Schema.String },
    success: Credential,
    error: Schema.Union([ProviderError, ServerError])
  }),
  Rpc.make("DeleteCredential", {
    payload: { credentialId: CredentialId },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Header values are bound to the connection's current host, like a key. */
  Rpc.make("SetConnectionHeaders", {
    payload: {
      connectionId: ConnectionId,
      headers: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
      expectedRowVersion: Schema.Int
    },
    success: Connection,
    error: Schema.Union([ProviderError, StaleWrite, ServerError])
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
    payload: {
      proxyUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
      bypass: Schema.Array(Schema.String),
      forceProxy: Schema.Boolean
    },
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
  }),
  // --- Library import (ARCHITECTURE.md §11). Files go in and out over HTTP
  // (POST /library/import, /library/export), since RPC messages are JSON.
  /** The user's upstream refs and variants of one kind, by label. */
  Rpc.make("ListLibrary", {
    payload: { kind: EntityKind },
    success: Schema.Array(LibraryRef),
    error: ServerError
  })
)
  // --- Chats (chatApi.ts).
  .merge(ChatApi)
  // --- Chat setup, speakers and the send queue (chatSetupApi.ts).
  .merge(ChatSetupApi)
  // --- ST data folder import (stImportApi.ts).
  .merge(StImportApi)
  // --- The card and preset editors (editorApi.ts).
  .merge(EditorApi)
  .middleware(Authentication) {}
