// The message graph as the rest of the app sees it (DATA-MODEL.md §4).
import { Schema } from "effect"
import { idSchema } from "./id.ts"

export const ChatId = idSchema("ChatId", "chat")
export type ChatId = typeof ChatId.Type
export const LaneId = idSchema("LaneId", "lane")
export type LaneId = typeof LaneId.Type
export const SlotId = idSchema("SlotId", "slot")
export type SlotId = typeof SlotId.Type
export const VersionId = idSchema("VersionId", "version")
export type VersionId = typeof VersionId.Type
export const EntityId = idSchema("EntityId", "entity")
export type EntityId = typeof EntityId.Type

export const ChatKind = Schema.Literals(["rp", "workshop"])
const ChatStatus = Schema.Literals(["pending", "active", "archived"])
export const VersionStatus = Schema.Literals(["generating", "complete", "stopped", "failed", "interrupted"])
export type VersionStatus = typeof VersionStatus.Type
const Writer = Schema.Literals(["human", "model"])
const MacroMode = Schema.Literals(["template", "verbatim"])
const VersionOrigin = Schema.Literals([
  "generated",
  "user_written",
  "edited",
  "greeting",
  "imported",
  "changeset",
  "scratchpad"
])

export class Chat extends Schema.Class<Chat>("Chat")({
  id: ChatId,
  kind: ChatKind,
  status: ChatStatus,
  title: Schema.String,
  activeLeafSlotId: Schema.NullOr(SlotId),
  rowVersion: Schema.Int,
  createdAt: Schema.Number,
  lastMessageAt: Schema.NullOr(Schema.Number)
}) {}

export class Version extends Schema.Class<Version>("Version")({
  id: VersionId,
  slotId: SlotId,
  ordinal: Schema.Int,
  status: VersionStatus,
  speakerEntityId: Schema.NullOr(EntityId),
  writer: Writer,
  content: Schema.String,
  macroMode: MacroMode,
  origin: VersionOrigin,
  sourceVersionId: Schema.NullOr(VersionId),
  direction: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  starred: Schema.Boolean,
  createdAt: Schema.Number
}) {}

/** One position on a path, with the version selected there. */
export class PathEntry extends Schema.Class<PathEntry>("PathEntry")({
  slotId: SlotId,
  laneId: LaneId,
  parentSlotId: Schema.NullOr(SlotId),
  depth: Schema.Int,
  rowVersion: Schema.Int,
  contextExcluded: Schema.Boolean,
  version: Version,
  versionCount: Schema.Int,
  /**
   * Whether this slot enters an assembled context. False for excluded slots and
   * for selections that are failed or still empty (DATA-MODEL §15, invariant 2).
   */
  inContext: Schema.Boolean
}) {}

/** What a new version is made of; the server fills in ids, ordinals and times. */
export class NewVersion extends Schema.Class<NewVersion>("NewVersion")({
  speakerEntityId: Schema.NullOr(EntityId),
  writer: Writer,
  content: Schema.String,
  status: VersionStatus,
  macroMode: MacroMode,
  origin: VersionOrigin,
  sourceVersionId: Schema.optional(VersionId),
  direction: Schema.optional(Schema.String),
  /** Required for failed versions: what went wrong (DESIGN §3.1). */
  error: Schema.optional(
    Schema.Struct({ class: Schema.String, message: Schema.String, detail: Schema.optional(Schema.Unknown) })
  )
}) {}

/** A version is usable in context when it has text and didn't fail (invariant 2). */
export const versionInContext = (status: VersionStatus, content: string, contextExcluded: boolean) =>
  !contextExcluded && status !== "failed" && content.length > 0
