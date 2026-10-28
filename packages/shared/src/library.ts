// Layered, versioned library documents (DESIGN §4, DATA-MODEL §3): cards, presets,
// lorebooks, notes and preset overlays. Revisions are immutable snapshots; refs are the
// movable pointers users pick. One mechanism serves all kinds.
import { Schema } from "effect"
import { idSchema } from "./id.ts"
import { ChatId, EntityId } from "./chat.ts"

export const EntityKind = Schema.Literals(["card", "preset", "lorebook", "note", "preset_overlay"])
export type EntityKind = typeof EntityKind.Type

/**
 * upstream: the base line (imported, or the original of something the user created).
 * Cards have exactly one upstream ref. The other kinds also support:
 * variant: a named fork that follows another ref, so upstream updates flow into it.
 * chat_override: changes for one chat only; it can be promoted to a variant.
 */
export const RefKind = Schema.Literals(["upstream", "variant", "chat_override"])
export type RefKind = typeof RefKind.Type

export const RefId = idSchema("RefId", "ref")
export type RefId = typeof RefId.Type
export const RevisionId = idSchema("RevisionId", "revision")
export type RevisionId = typeof RevisionId.Type

/** A library document: any JSON object. Per-kind schemas arrive with the importers. */
export const Doc = Schema.Record(Schema.String, Schema.Unknown)
export type Doc = typeof Doc.Type

export class LibraryRef extends Schema.Class<LibraryRef>("LibraryRef")({
  id: RefId,
  entityId: EntityId,
  kind: EntityKind,
  refKind: RefKind,
  /** For cards, label and subtitle derive from this revision’s name and character_version. */
  label: Schema.String,
  subtitle: Schema.String,
  headRevisionId: RevisionId,
  followsRefId: Schema.NullOr(RefId),
  chatId: Schema.NullOr(ChatId),
  /** The ref it follows has moved on since the last merge. */
  updateAvailable: Schema.Boolean,
  /** Whether this entry has an import line to update from a file. */
  hasImport: Schema.optionalKey(Schema.Boolean),
  rowVersion: Schema.Int,
  updatedAt: Schema.Number
}) {}

export class Revision extends Schema.Class<Revision>("Revision")({
  id: RevisionId,
  parents: Schema.Array(RevisionId),
  origin: Schema.Literals(["import", "user", "agent", "changeset", "merge"]),
  message: Schema.NullOr(Schema.String),
  docHash: Schema.String,
  createdAt: Schema.Number
}) {}

export const MergeOutcome = Schema.Literals(["up_to_date", "fast_forward", "merged", "conflicts"])
export type MergeOutcome = typeof MergeOutcome.Type

/** A conflict's value on each side; a side with no value there (added or deleted) has none. */
export class MergeConflictInfo extends Schema.Class<MergeConflictInfo>("MergeConflictInfo")({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  base: Schema.optionalKey(Schema.Unknown),
  ours: Schema.optionalKey(Schema.Unknown),
  theirs: Schema.optionalKey(Schema.Unknown)
}) {}

/** What merging a ref with the one it follows would do, for the resolver UI. */
export class MergePreview extends Schema.Class<MergePreview>("MergePreview")({
  outcome: MergeOutcome,
  /** The merged document: the clean changes merged, and ours at each conflict. */
  merged: Doc,
  conflicts: Schema.Array(MergeConflictInfo),
  /** The followed ref's head that this preview merged in. */
  theirsRevisionId: RevisionId
}) {}

/** Where a card stands: in the library (live or archived), in the bin, or deleted for good. */
export const FamilyMemberState = Schema.Literals(["live", "archived", "binned", "purged"])
export type FamilyMemberState = typeof FamilyMemberState.Type

/** One card of a family (spec/CARD-FORKS.md surface 4): connected to the others by forking. */
export class FamilyMember extends Schema.Class<FamilyMember>("FamilyMember")({
  entityId: EntityId,
  /** The card it was forked from (or marked a fork of); null for the family's root. */
  parentEntityId: Schema.NullOr(EntityId),
  /** The ref it opens in, the card's library entry; null once deleted for good. */
  refId: Schema.NullOr(RefId),
  /** Display name and version, from its head's standard card fields; empty once deleted for good. */
  label: Schema.String,
  subtitle: Schema.String,
  state: FamilyMemberState,
  /** The parent's revision it copied; null when marked a fork of an existing card, or that revision is gone. */
  forkedFromRevisionId: Schema.NullOr(RevisionId),
  /** The chat it was forked for, while that chat exists. */
  forkedInChatId: Schema.NullOr(ChatId),
  forkedAt: Schema.NullOr(Schema.Number),
  /** The user's live chats it joined, and the last message among them. */
  chats: Schema.Int,
  lastMessageAt: Schema.NullOr(Schema.Number)
}) {}

/** Every card connected to one by forking, the same from any member, oldest first. */
export class CardFamily extends Schema.Class<CardFamily>("CardFamily")({
  rootEntityId: EntityId,
  members: Schema.Array(FamilyMember)
}) {}
