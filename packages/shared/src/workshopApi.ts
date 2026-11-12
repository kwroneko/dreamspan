import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

/** What the assistant may do with a capability in one workshop (spec/WORKSHOP.md §3.4). */
export const CapabilityMode = Schema.Literals(["allow", "ask", "off"])
export type CapabilityMode = typeof CapabilityMode.Type

export const WorkshopCapability = Schema.Struct({
  id: Schema.String,
  order: Schema.Number,
  label: Schema.String,
  explanation: Schema.String,
  /** A plain example of what it covers, for the hover explanation. */
  example: Schema.optionalKey(Schema.String),
  /** How it stands in this workshop: the workshop's choice, else the default. */
  mode: CapabilityMode,
  /** The default, from the one registered defaults table. */
  defaultMode: CapabilityMode,
  /** The choices it offers, in order; one means it can't be changed. */
  modes: Schema.Array(CapabilityMode),
  /** This workshop chose `mode` (it isn't the default). */
  chosen: Schema.Boolean,
  /** Only one choice: it can't be changed. */
  always: Schema.optionalKey(Schema.Boolean)
})
export type WorkshopCapability = typeof WorkshopCapability.Type

/** An approval the server refused: answered already, no longer waiting, or for another call. */
export class ApprovalRefused extends Schema.TaggedError<ApprovalRefused>()("ApprovalRefused", {
  message: Schema.String
}) {}

/** A grant the server refused: a capability this workshop doesn't offer, or a choice it can't take. */
export class GrantRefused extends Schema.TaggedError<GrantRefused>()("GrantRefused", {
  message: Schema.String
}) {}

export const ApprovalAnswer = Schema.Literals(["allow", "allow_chat", "deny"])
export type ApprovalAnswer = typeof ApprovalAnswer.Type

export class EffectUndoRefused extends Schema.TaggedError<EffectUndoRefused>()("EffectUndoRefused", {
  message: Schema.String
}) {}

export const RolloutEffectRecord = Schema.Struct({
  kind: Schema.String,
  targetKind: Schema.String,
  targetId: Schema.String,
  title: Schema.String,
  undo: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
})
export type RolloutEffectRecord = typeof RolloutEffectRecord.Type
export const RolloutEffect = Schema.Struct({
  rolloutId: Schema.String,
  toolCallId: Schema.String,
  seq: Schema.Int,
  ...RolloutEffectRecord.fields,
  undoResult: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  undoneAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number
})
export type RolloutEffect = typeof RolloutEffect.Type
export const EffectKey = { rolloutId: Schema.String, toolCallId: Schema.String, seq: Schema.Int }
export const EffectList = {
  chatId: Chat.fields.id,
  before: Schema.optionalKey(
    Schema.Struct({ createdAt: Schema.Number, rolloutId: Schema.String, toolCallId: Schema.String, seq: Schema.Int })
  ),
  limit: Schema.optionalKey(Schema.Int)
}

export class WorkshopApi extends RpcGroup.make(
  Rpc.make("ListWorkshopCapabilities", {
    payload: { chatId: Chat.fields.id },
    success: Schema.Array(WorkshopCapability),
    error: Schema.Union([NotFound, ServerError])
  }),
  /** `attachTo`: a side chat beside that story, reading it through its tools (spec/WORKSHOP.md §4). */
  Rpc.make("CreateWorkshop", {
    payload: { title: Schema.optionalKey(Schema.String), attachTo: Schema.optionalKey(Chat.fields.id) },
    success: Chat,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The workshops beside a story, newest first. */
  Rpc.make("ListAttachedWorkshops", {
    payload: { chatId: Chat.fields.id },
    success: Schema.Array(Chat),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("ListRolloutEffects", {
    payload: EffectList,
    success: Schema.Array(RolloutEffect),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("UndoRolloutEffect", {
    payload: EffectKey,
    success: RolloutEffect,
    error: Schema.Union([NotFound, EffectUndoRefused, ServerError])
  }),
  /** Sets what the assistant may do with a capability in this workshop; null goes back to the default. */
  Rpc.make("SetWorkshopGrant", {
    payload: { chatId: Chat.fields.id, capability: Schema.String, mode: Schema.NullOr(CapabilityMode) },
    success: Schema.Array(WorkshopCapability),
    error: Schema.Union([NotFound, GrantRefused, ServerError])
  }),
  /**
   * Answers a tool call waiting for the user, bound to that call: its rollout, its id and its
   * arguments' digest. `allow_chat` also allows the capability in this workshop.
   */
  Rpc.make("AnswerToolApproval", {
    payload: {
      rolloutId: Schema.String,
      toolCallId: Schema.String,
      digest: Schema.String,
      answer: ApprovalAnswer,
      note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000)))
    },
    success: Schema.Struct({ waiting: Schema.Boolean }),
    error: Schema.Union([NotFound, ApprovalRefused, ServerError])
  }),
  /** The changes a reply's run made, for its steps' Undo and Open and the regenerate warning. */
  Rpc.make("ListVersionEffects", {
    payload: { versionId: Schema.String },
    success: Schema.Array(RolloutEffect),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
