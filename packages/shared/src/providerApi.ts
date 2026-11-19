// The providers a new connection starts from (providerDefinitions.ts), in a group of their own:
// AppCoreApi is at TypeScript's instantiation depth (TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { RecomputePreview, RecomputeTarget } from "./costFormulas.ts"
import { ProviderError, ServerError } from "./errors.ts"
import { ConnectionId, Model, ModelId, PriceFeedState, ProviderInfo } from "./providers.ts"

export class ProviderListApi extends RpcGroup.make(
  /** Built-in and from plugins, in picker order, each with an API type in effect. */
  Rpc.make("ListProviders", { success: Schema.Array(ProviderInfo) }),
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
