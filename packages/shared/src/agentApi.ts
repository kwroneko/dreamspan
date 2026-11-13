// The agent RPCs (spec/AGENTIC.md §5, §6).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  ACTIVITY_PAGE,
  ActivityCursor,
  ActivityPage,
  NotResumable,
  ReplyTools,
  RolloutStep,
  RunTranscript,
  StepEdit
} from "./agent.ts"
import { ChatId, EntityId, ForkId, PathEntry, SlotId, StoryAtField, VersionId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { REPLACEABLE_CARD_FIELDS } from "./docs/note.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"

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
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField,
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
      expectedRowVersion: Schema.Int,
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField
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
