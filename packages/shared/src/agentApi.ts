// The agent RPCs (spec/AGENTIC.md §5).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotResumable, RolloutStep, StepEdit } from "./agent.ts"
import { ForkId, PathEntry, VersionId } from "./chat.ts"
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
  })
) {}
