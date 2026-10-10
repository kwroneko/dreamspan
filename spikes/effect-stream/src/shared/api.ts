import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const VersionStatus = Schema.Literals(["generating", "complete", "stopped", "failed"])
export type VersionStatus = typeof VersionStatus.Type

export class Version extends Schema.Class<Version>("Version")({
  id: Schema.String,
  slotId: Schema.String,
  ordinal: Schema.Int,
  content: Schema.String,
  status: VersionStatus,
  rowVersion: Schema.Int
}) {}

export class Slot extends Schema.Class<Slot>("Slot")({
  id: Schema.String,
  depth: Schema.Int,
  selectedVersionId: Schema.String,
  versions: Schema.Array(Version)
}) {}

/** Pushed to subscribers. Deltas carry only the new text, never the whole message. */
export const ChatEvent = Schema.Union([
  Schema.TaggedStruct("VersionCreated", { version: Version }),
  Schema.TaggedStruct("Delta", { versionId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("StatusChanged", {
    versionId: Schema.String,
    status: VersionStatus,
    error: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("ContentReplaced", {
    versionId: Schema.String,
    content: Schema.String,
    rowVersion: Schema.Int
  })
])
export type ChatEvent = typeof ChatEvent.Type

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String
}) {}

/** Optimistic concurrency: the row moved on since the client read it. */
export class StaleWrite extends Schema.TaggedError<StaleWrite>()("StaleWrite", {
  versionId: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int
}) {}

export class ChatApi extends RpcGroup.make(
  Rpc.make("ListSlots", {
    payload: { chatId: Schema.String },
    success: Schema.Array(Slot)
  }),
  /** Each stream element is one batch, coalesced on the server over ~16 ms. */
  Rpc.make("Subscribe", {
    payload: { chatId: Schema.String },
    success: Schema.Array(ChatEvent),
    stream: true
  }),
  Rpc.make("Generate", {
    payload: {
      slotId: Schema.String,
      tokensPerSecond: Schema.Int,
      tokens: Schema.Int
    },
    success: Version,
    error: NotFound
  }),
  Rpc.make("Stop", {
    payload: { versionId: Schema.String },
    success: Schema.Boolean
  }),
  Rpc.make("EditVersion", {
    payload: {
      versionId: Schema.String,
      content: Schema.String,
      expectedRowVersion: Schema.Int
    },
    success: Version,
    error: Schema.Union([NotFound, StaleWrite])
  }),
  /** Spike helper: bumps a row's version as if another tab had written it. */
  Rpc.make("TouchVersion", {
    payload: { versionId: Schema.String },
    success: Version,
    error: NotFound
  }),
  /** Spike helper: how many provider calls saw their AbortSignal fire. */
  Rpc.make("ProviderStats", {
    success: Schema.Struct({ started: Schema.Int, aborted: Schema.Int, completed: Schema.Int, closed: Schema.Int })
  })
) {}
