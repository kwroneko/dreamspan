// The agent RPCs (spec/AGENTIC.md §5, §6).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  ACTIVITY_PAGE,
  ActivityCursor,
  ActivityPage,
  ModelBehaviour,
  NotResumable,
  ReplyTools,
  RolloutStep,
  RunTranscript,
  StepEdit,
  SubagentRow
} from "./agent.ts"
import { InspectorUsage } from "./inspectorApi.ts"
import { ChatId, EntityId, ForkId, PathEntry, SlotId, VersionId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { REPLACEABLE_CARD_FIELDS } from "./docs/note.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import {
  SubagentLimits,
  SubagentModelRow,
  SubagentPick,
  SubagentPicks,
  SubagentSettings,
  SubagentSettingsRejected
} from "./subagents.ts"

/**
 * One thing agent replies may or may not change in a chat (spec/AGENTIC.md §4.3): `on` is what
 * holds at the position, `own` the note's or card's own setting, which the chat's
 * `agent.permission` overrides when `chosen`.
 */
const PermissionState = { on: Schema.Boolean, own: Schema.Boolean, chosen: Schema.Boolean }

/** What agent replies may change in a chat at a position: its notes, and its cards' fields. */
export const AgentPermissions = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      entityId: EntityId,
      title: Schema.String,
      /** The card whose note it is; null for the chat's own. */
      card: Schema.NullOr(EntityId),
      /** It shows a shared note's text, which only that note's editor changes. */
      linked: Schema.Boolean,
      ...PermissionState
    })
  ),
  cards: Schema.Array(
    Schema.Struct({
      entityId: EntityId,
      name: Schema.String,
      fields: Schema.Array(Schema.Struct({ field: Schema.Literals(REPLACEABLE_CARD_FIELDS), ...PermissionState }))
    })
  )
})
export type AgentPermissions = typeof AgentPermissions.Type

const ResumeErrors = [NotFound, StaleWrite, ServerError, GenerationUnavailable, NotResumable] as const

/**
 * A subagent's own run, as its Inspect link opens it (spec/SUBAGENTS.md §7): what it was asked
 * and with which instructions, the tools it was offered, every turn after its request, and its
 * requests from the ledger. `startedBy`: the reply whose `agent` call started it.
 */
export const SubagentRun = Schema.Struct({
  row: SubagentRow,
  startedBy: Schema.Struct({ versionId: VersionId, toolCallId: Schema.String }),
  /** The type's instructions, as the subagent's first message held them. */
  instructions: Schema.String,
  tools: RunTranscript.fields.tools,
  entries: RunTranscript.fields.entries,
  requests: Schema.Array(InspectorUsage),
  /** The run's error, when it failed. */
  error: Schema.NullOr(Schema.String)
})
export type SubagentRun = typeof SubagentRun.Type

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
      expectedRowVersion: Schema.Int,
      /**
       * Sends the stopped run's stored request unchanged, with its model and tools, instead of
       * building it on the chat's settings now: only when the user chose it after a
       * `NotResumable` with `savedRequest` (spec/AGENTIC.md §12.4).
       */
      saved: Schema.optionalKey(Schema.Boolean)
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
  /** Per model, how its story replies met the send tool's contract (spec/REPLY-CONTRACT.md §3.6). */
  Rpc.make("GetModelBehaviour", {
    success: Schema.Array(ModelBehaviour),
    error: ServerError
  }),
  /**
   * A subagent's own run (spec/SUBAGENTS.md §7): `rolloutId` must be a subagent started by the run
   * of `versionId` (or a run it carried on), so it's read only through the reply it belongs to.
   */
  Rpc.make("GetSubagentRun", {
    payload: { versionId: VersionId, rolloutId: Schema.String },
    success: SubagentRun,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Stops one running subagent of the reply `versionId` (spec/SUBAGENTS.md §8): it ends stopped,
   * and the assistant gets what it wrote so far and carries on. Nothing else stops. `stopped`:
   * whether it was still running here.
   */
  Rpc.make("StopSubagent", {
    payload: { versionId: VersionId, rolloutId: Schema.String },
    success: Schema.Struct({ stopped: Schema.Boolean }),
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The account's subagent models and limits (spec/SUBAGENTS.md §5.1, §6.2), defaults filled in. */
  Rpc.make("GetSubagentSettings", { payload: {}, success: SubagentSettings, error: ServerError }),
  /**
   * Changes the account's subagent settings: `picks`, the models every chat's subagents may use
   * unless the chat is locked to its own (the subagent model chip's account choice); `rows`, models'
   * aliases, notes and limits (each row given replaces that model's); `limits`, null for the defaults.
   */
  Rpc.make("ChangeSubagentSettings", {
    payload: {
      picks: Schema.optionalKey(SubagentPicks),
      rows: Schema.optionalKey(Schema.Record(SubagentPick, SubagentModelRow)),
      limits: Schema.optionalKey(Schema.NullOr(SubagentLimits))
    },
    success: Schema.Void,
    error: Schema.Union([SubagentSettingsRejected, ServerError])
  }),
  /** What agent replies may change in the chat at the position the chat's settings show (`slotId`). */
  Rpc.make("GetAgentPermissions", {
    payload: { chatId: ChatId, slotId: Schema.NullOr(SlotId), forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: AgentPermissions,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The reply modes and the tools agent modes can offer, as registered now. */
  Rpc.make("ListReplyTools", { payload: {}, success: ReplyTools, error: ServerError }),
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
