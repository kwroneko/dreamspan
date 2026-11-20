// The providers a new connection starts from (providerDefinitions.ts), in a group of their own:
// AppCoreApi is at TypeScript's instantiation depth (TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { RecomputePreview, RecomputeTarget } from "./costFormulas.ts"
import { ProviderError, ProviderErrorReason, ServerError } from "./errors.ts"
import {
  ConnectionId,
  ConnectionSettings,
  CredentialId,
  Model,
  ModelId,
  PriceFeedState,
  ProviderInfo,
  ProviderKind
} from "./providers.ts"

/** The one short message a connection check sends to a model, and what came back. */
export class ConnectionTestReply extends Schema.Class<ConnectionTestReply>("ConnectionTestReply")({
  /** The model id it went to. */
  model: Schema.String,
  ok: Schema.Boolean,
  /** The start of the model's reply; empty when it answered with no text. */
  text: Schema.String,
  /** From sending to the end of the reply. */
  ms: Schema.Number,
  route: Schema.NullOr(Schema.String),
  /** Why it failed, the HTTP status, and the provider's own words (secrets removed); null when it worked. */
  reason: Schema.NullOr(ProviderErrorReason),
  status: Schema.NullOr(Schema.Int),
  detail: Schema.NullOr(Schema.String)
}) {}

/**
 * The result of checking a connection: its model list (with the route that request took), and,
 * when a model was named, one short message to it.
 */
export class ConnectionTest extends Schema.Class<ConnectionTest>("ConnectionTest")({
  /** The list was fetched and, when one was sent, the message was answered. */
  ok: Schema.Boolean,
  /** What the list request found, or the provider's words when it failed. */
  detail: Schema.String,
  route: Schema.NullOr(Schema.String),
  models: Schema.NullOr(Schema.Int),
  /** Why the list failed, and its HTTP status; null when it didn't. */
  reason: Schema.NullOr(ProviderErrorReason),
  status: Schema.NullOr(Schema.Int),
  /** The listed model ids, at most `TEST_MODEL_KEYS`, for picking one to send to. */
  modelKeys: Schema.Array(Schema.String),
  /** How long the list took. */
  ms: Schema.NullOr(Schema.Number),
  /** Whether the list is a built-in catalog: nothing was sent to list it. */
  catalog: Schema.Boolean,
  reply: Schema.NullOr(ConnectionTestReply)
}) {}

/** The most model ids a connection check returns. */
export const TEST_MODEL_KEYS = 2000

export class ProviderListApi extends RpcGroup.make(
  /** Built-in and from plugins, in picker order, each with an API type in effect. */
  Rpc.make("ListProviders", { success: Schema.Array(ProviderInfo) }),
  /**
   * `TestConnection` for a connection not yet created, as `CreateConnection` would make it, with
   * a model id from its list. Nothing is stored: not the connection, the key or the request.
   */
  Rpc.make("TestConnectionDraft", {
    payload: {
      provider: Schema.optionalKey(Schema.String),
      kind: ProviderKind,
      settings: ConnectionSettings,
      apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
      credentialId: Schema.optionalKey(Schema.NullOr(CredentialId)),
      model: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    success: ConnectionTest,
    error: Schema.Union([ProviderError, ServerError])
  }),
  /** Fetches OpenRouter's per-provider prices for one model, used when its routing pins a provider. */
  Rpc.make("RefreshModelEndpoints", {
    payload: { modelId: ModelId },
    success: Model,
    error: Schema.Union([ProviderError, ServerError])
  }),
  /**
   * What the connection's price endpoint answered last (spec/PRICES.md §4.5); null when it
   * hasn't been asked since the server started, or the connection isn't opted in.
   */
  Rpc.make("GetPriceFeedState", {
    payload: { connectionId: ConnectionId },
    success: Schema.NullOr(PriceFeedState),
    error: Schema.Union([ProviderError, ServerError])
  }),
  /** How many past requests "Apply to past requests" would re-price (spec/PRICES.md §6.1). Changes nothing. */
  Rpc.make("PreviewCostRecompute", {
    payload: { target: RecomputeTarget },
    success: RecomputePreview,
    error: ServerError
  }),
  /** Re-prices those past requests with today's prices; `changed` is how many were. */
  Rpc.make("ApplyCostRecompute", {
    payload: { target: RecomputeTarget },
    success: Schema.Struct({ changed: Schema.Int }),
    error: ServerError
  })
) {}
