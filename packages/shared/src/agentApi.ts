// The agent RPCs (spec/AGENTIC.md §5, §6).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ACTIVITY_PAGE, ActivityCursor, ActivityPage, NotResumable, ReplyModes, RolloutStep, RunTranscript, StepEdit } from "./agent.ts"
import { ChatId, ForkId, PathEntry, VersionId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"

const ResumeErrors = [NotFound, StaleWrite, ServerError, GenerationUnavailable, NotResumable] as const

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
  /**
   * Carries on an agent reply that stopped, failed or was interrupted (DESIGN §7.5): a new
   * version of the slot, selected, whose run goes on from the stopped one's transcript without
   * another turn, so the model can't tell. The stopped version stays as it was.
   */
  Rpc.make("ResumeVersion", {
    payload: {
      versionId: VersionId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int
    },
    success: PathEntry,
    error: Schema.Union([...ResumeErrors])
  }),
  /**
   * Carries on an agent reply from one of its steps (`step`: its index in the version's steps),
   * changed by `edit` first if given (spec/AGENTIC.md §4.4), as a new version. What came after
   * the step is dropped from the new run, and the effects of the tool calls dropped with it.
   */
  Rpc.make("ResumeFromStep", {
    payload: {
      versionId: VersionId,
      step: Schema.Int,
      edit: Schema.optionalKey(StepEdit),
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int
    },
    success: PathEntry,
    error: Schema.Union([...ResumeErrors])
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
