// The decision-model settings RPCs (spec/AGENTIC.md §7), in a group of their own: AppCoreApi is
// at TypeScript's instantiation depth (TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ConnectionDecisions, DecisionPointSetting, DecisionPointInfo } from "./decisions.ts"
import { NotFound, ServerError } from "./errors.ts"
import { ConnectionId, ModelId } from "./providers.ts"

export class DecisionApi extends RpcGroup.make(
  /** The registered decision points, in order. */
  Rpc.make("ListDecisionPoints", { success: Schema.Array(DecisionPointInfo), error: ServerError }),
  /** The user's decision settings, one entry per connection that has any; others send nothing. */
  Rpc.make("GetDecisionSettings", { success: Schema.Array(ConnectionDecisions), error: ServerError }),
  /**
   * A connection's decision settings, replacing what it had. NotFound when the connection, or
   * the model (which must be the connection's), isn't the user's.
   */
  Rpc.make("SetDecisionSettings", {
    payload: {
      connectionId: ConnectionId,
      model: Schema.NullOr(ModelId),
      points: Schema.Record(Schema.String, DecisionPointSetting)
    },
    success: Schema.Array(ConnectionDecisions),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
