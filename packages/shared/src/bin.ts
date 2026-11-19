// The recycle bin (DESIGN §6.2): two independent sections, each with its own capacity.
import { Schema } from "effect"
import { DraftTargetKind } from "./drafts.ts"
import { ForkSplit } from "./chat.ts"
import { SlotId } from "./chatPosition.ts"

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

/**
 * A branch that deleting a bin item for good affects (`BinItemBranches`), for the list the
 * confirmation shows. `state`: `shown`, a live branch shows the text; `deletedHere`, a live
 * branch deleted it in its own view, so it's in the bin for it; `branchInBin`, the branch itself
 * is in the bin; `chatInBin`, the whole chat is. `shows`: it shows the text, a branch in the bin
 * included: exactly the forks `BinItemForks` names, which the purge's confirmation compares.
 * Named as the chat's branch list names it: `name`, else "Original" for the chat's first fork
 * (`original`), else "Branch `number`", numbered by when it was made among the chat's live
 * branches made from another. `position`: where the item's message is in that branch, from 0
 * (null for a branch or chat item). `link`: the message to open the branch at, the item's own
 * where it shows it, else the nearest message it shows above it (or below, with none above);
 * null when the branch can't be opened (it or its chat is in the bin) or shows nothing near it.
 */
export class BinBranch extends Schema.Class<BinBranch>("BinBranch")({
  itemId: Schema.String,
  chatId: Schema.String,
  chatTitle: Schema.String,
  forkId: Schema.String,
  name: Schema.NullOr(Schema.String),
  original: Schema.Boolean,
  number: Schema.NullOr(Schema.Int),
  /** Where it parts from its parent, while known (`forkLabel`). */
  split: Schema.optionalKey(Schema.NullOr(ForkSplit)),
  createdAt: Schema.optionalKey(Schema.Number),
  tipExcerpt: Schema.String,
  current: Schema.Boolean,
  state: Schema.Literals(["shown", "deletedHere", "branchInBin", "chatInBin"]),
  shows: Schema.Boolean,
  position: Schema.NullOr(Schema.Int),
  link: Schema.NullOr(Schema.Struct({ slotId: Schema.String, position: Schema.Int }))
}) {}

const BinItemKind = Schema.Literals([
  "chat",
  "message",
  "branch",
  "threads",
  "version",
  "entity",
  "connection",
  "card_asset",
  "mcp_connection",
  // A file or folder of the account's Files (spec/FILES-AND-ENVIRONMENT.md §1.3): its content
  // waits on disk outside the tree; restoring and emptying it run on the files host.
  "file"
])

/** Something explicitly deleted: a chat, a message, a swipe, a branch, threads started together (their Undo), a library entity, a connection. */
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

/** The most messages one multi-delete takes, and one Undo puts back (job msgactions1). */
export const MULTI_DELETE_LIMIT = 1000
/** A multi-delete's messages, in the path's order, top down. */
export const DeletedSlots = Schema.Array(SlotId).check(Schema.isMinLength(1), Schema.isMaxLength(MULTI_DELETE_LIMIT))
/** A multi-delete's bin items, for its Undo. */
export const RestoredItems = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MULTI_DELETE_LIMIT)
)

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
