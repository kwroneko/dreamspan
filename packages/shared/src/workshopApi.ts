import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

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
  Rpc.make("CreateWorkshop", {
    payload: { title: Schema.optionalKey(Schema.String) },
    success: Chat,
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
  })
) {}
