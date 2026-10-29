// The recycle bin (DESIGN §6.2): two independent sections, each with its own capacity.
import { Schema } from "effect"
import { DraftTargetKind } from "./drafts.ts"

/** The deleted-item set changed since the user confirmed it. */
export class BinChanged extends Schema.TaggedError<BinChanged>()("BinChanged", {}) {}

/** A chat keeps at least one fork: deleting its last live one would leave nothing to open. */
export class CannotDeleteLastFork extends Schema.TaggedError<CannotDeleteLastFork>()("CannotDeleteLastFork", {}) {}

/**
 * A fork that shows what a bin item holds, which deleting the item for good erases in it too
 * (owner, 2026-10-27): the client names these in its warning. `deleted`: the fork is in the bin.
 */
export class BinForkShown extends Schema.Class<BinForkShown>("BinForkShown")({
  itemId: Schema.String,
  forkId: Schema.String,
  chatTitle: Schema.String,
  name: Schema.NullOr(Schema.String),
  tipExcerpt: Schema.String,
  deleted: Schema.Boolean
}) {}

const BinItemKind = Schema.Literals(["chat", "message", "branch", "version", "entity", "connection"])

/** Something explicitly deleted: a chat, a message, a swipe, a branch, a library entity, a connection. */
export class BinItem extends Schema.Class<BinItem>("BinItem")({
  id: Schema.String,
  kind: BinItemKind,
  targetId: Schema.String,
  title: Schema.String,
  excerpt: Schema.String,
  /** Where it came from (chat, position, branch), so its text can be used without restoring. */
  origin: Schema.Record(Schema.String, Schema.Unknown),
  byteSize: Schema.Int,
  deletedAt: Schema.Number
}) {}

/** Draft text that would otherwise have been lost, saved passively. */
export class RecoveredText extends Schema.Class<RecoveredText>("RecoveredText")({
  id: Schema.String,
  sourceKind: DraftTargetKind,
  sourceId: Schema.String,
  sourceField: Schema.String,
  /** Where it was typed, e.g. "Mira › description" or "Composer in Harbor". */
  sourceLabel: Schema.String,
  /**
   * commit: from before a destructive change or another tab's save gone over, saved when the
   * session was committed or when history retention dropped the change; discard: a
   * discarded draft, or text saved after its draft was sent.
   */
  reason: Schema.Literals(["commit", "discard"]),
  /** The full text for a single read; an excerpt in lists. */
  content: Schema.String,
  length: Schema.Int,
  createdAt: Schema.Number
}) {}

/** Each section's capacity. Past either limit, that section's oldest entries go first. */
const Capacity = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
export const BinLimits = Schema.Struct({
  deletedItems: Capacity,
  deletedBytes: Capacity,
  recoveredTexts: Capacity,
  recoveredBytes: Capacity
})
export type BinLimits = typeof BinLimits.Type
const BinLimitKey = Schema.Literals(["deletedItems", "deletedBytes", "recoveredTexts", "recoveredBytes"])
export const BinLimitChange = Schema.Struct({ key: BinLimitKey, value: Capacity })

export const defaultBinLimits: BinLimits = {
  deletedItems: 10_000,
  deletedBytes: 2 * 1024 ** 3,
  recoveredTexts: 2_000,
  recoveredBytes: 200 * 1024 ** 2
}
