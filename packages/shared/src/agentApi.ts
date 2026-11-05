// The agent RPCs (spec/AGENTIC.md §5, §6).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ACTIVITY_PAGE, ActivityCursor, ActivityPage, ReplyModes, RolloutStep, RunTranscript } from "./agent.ts"
import { ChatId, VersionId } from "./chat.ts"
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
  }),
  /** A version's run after its request, verbatim, with the tools it was offered; empty for a plain reply. */
  Rpc.make("GetRunTranscript", {
    payload: { versionId: VersionId },
    success: RunTranscript,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The reply modes and the tools agent modes can offer, as registered now. */
  Rpc.make("ListReplyModes", { payload: {}, success: ReplyModes, error: ServerError }),
  /** A chat's model work that made no message, newest first (spec/AGENTIC.md §5.4). */
  Rpc.make("ListActivity", {
    payload: {
      chatId: ChatId,
      before: Schema.optionalKey(ActivityCursor),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ACTIVITY_PAGE })))
    },
    success: ActivityPage,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
