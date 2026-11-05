// The agent RPCs (spec/AGENTIC.md §5).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { RolloutStep } from "./agent.ts"
import { VersionId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

/**
 * The agent RPCs, in a group (and handler layer) of their own: AppCoreApi is at TypeScript's
 * instantiation depth (TS2589).
 */
export class AgentApi extends RpcGroup.make(
  /** A version's steps as its transcript holds them; empty for a plain reply. */
  Rpc.make("GetRolloutSteps", {
    payload: { versionId: VersionId },
    success: Schema.Array(RolloutStep),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
