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
export const ForkId = idSchema("ForkId", "fork")
export type ForkId = typeof ForkId.Type
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
  "scratchpad",
  "duplicate"
])

export class Chat extends Schema.Class<Chat>("Chat")({
  id: ChatId,
  kind: ChatKind,
  status: ChatStatus,
  title: Schema.String,
  /** The current fork's tip (`currentForkId`). */
  activeLeafSlotId: Schema.NullOr(SlotId),
  /**
   * The fork the chat opens on: the one last chatted in or created by forking, whichever is
   * more recent (spec/FORK-INDEPENDENCE-DELTA.md §2.1).
   */
  currentForkId: Schema.NullOr(ForkId),
  rowVersion: Schema.Int,
  createdAt: Schema.Number,
  lastMessageAt: Schema.NullOr(Schema.Number)
}) {}

/**
 * One line of a chat as the user sees it: history from the first message to its tip
 * (spec/FORK-INDEPENDENCE-DELTA.md §2.1). Forks share their history's messages; a fork made
 * at a message has that message as its base and, until something is sent in it, its tip.
 */
export class Fork extends Schema.Class<Fork>("Fork")({
  id: ForkId,
  chatId: ChatId,
  /** The fork it was made from; null for the chat's first. */
  parentForkId: Schema.NullOr(ForkId),
  /** The message it was made at; null when it starts at the first message. */
  baseSlotId: Schema.NullOr(SlotId),
  /** Where its path ends; null before its first message. */
  tipSlotId: Schema.NullOr(SlotId),
  name: Schema.NullOr(Schema.String),
  pinnedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  lastChattedAt: Schema.NullOr(Schema.Number),
  /** The start of its tip's text; empty without one. */
  tipExcerpt: Schema.String,
  /** It's the chat's current fork (`Chat.currentForkId`). */
  current: Schema.Boolean,
  rowVersion: Schema.Int
}) {}

/**
 * Values a text's non-deterministic macros drew, by the engine's keys (macros/expand.ts).
 * One expansion bounds them (ARCHITECTURE §10): no more values than the 10,000 macros it
 * evaluates, and no more text in all than its work limit produces (4,000,000 characters,
 * here with room to spare). Whatever an expansion drew fits.
 */
const FROZEN_MACROS_CHARACTERS = 16_000_000
export const FrozenMacros = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((record: Readonly<Record<string, string>>) => {
    const values = Object.values(record)
    if (values.length > 10_000) return "at most 10,000 frozen values"
    return values.reduce((sum, value) => sum + value.length, 0) <= FROZEN_MACROS_CHARACTERS
      ? undefined
      : "at most 16,000,000 characters of frozen values"
  })
)

/** Why a generation failed, shown on its version (DESIGN §3.1). */
export const VersionError = Schema.Struct({ class: Schema.String, message: Schema.String })

/**
 * Something about an assembled context the user should know: a prefill dropped, a piece
 * left out, history cut by the budget (ARCHITECTURE §15).
 */
export const ContextIssue = Schema.Struct({
  kind: Schema.Literals([
    "prefill_dropped",
    "images_unsupported",
    "images_limited",
    "macro_limit",
    "history_truncated",
    "summary_failed",
    "examples_truncated",
    "regex_skipped",
    "lorebook_issue",
    // Recorded by contexts assembled before version 30; never shown (ARCHITECTURE §15).
    "last_turn_filled",
    "layout_ignored",
    "cache_breakpoints",
    "role_projection_missing"
  ]),
  message: Schema.String
})
export type ContextIssue = typeof ContextIssue.Type

/** Ordered, version-owned image references. Bytes are uploaded separately. */
export const MessageImages = Schema.Array(
  Schema.Struct({
    mediaId: Schema.String,
    altText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000)))
  })
).check(Schema.isMaxLength(32))
export type MessageImages = typeof MessageImages.Type

export class Version extends Schema.Class<Version>("Version")({
  id: VersionId,
  slotId: SlotId,
  ordinal: Schema.Int,
  status: VersionStatus,
  speakerEntityId: Schema.NullOr(EntityId),
  writer: Writer,
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  macroMode: MacroMode,
  origin: VersionOrigin,
  sourceVersionId: Schema.NullOr(VersionId),
  direction: Schema.NullOr(Schema.String),
  /** Left out of the arrows' cycle; still listed in the version picker, under Hidden. */
  hidden: Schema.Boolean,
  /** Starred in the version picker, which can show only these. */
  starred: Schema.Boolean,
  createdAt: Schema.Number,
  /**
   * The model it was generated with, as "connection · model", when one is recorded: from
   * the start for "Regenerate with…", otherwise once its context is assembled. Null for
   * text a person wrote, and for imported versions.
   */
  model: Schema.NullOr(Schema.String),
  /** Set on failed versions only. */
  error: Schema.NullOr(VersionError),
  /**
   * The reasoning ("thinking") the model streamed before or beside its text, kept as it came
   * and shown apart from it. Never sent back in a context (ARCHITECTURE §15). Absent without any.
   */
  reasoning: Schema.optionalKey(Schema.String),
  /**
   * A judge model read this version's text and found a refusal (spec/LCM.md §2.4). The text
   * stays; a provider's own refusal makes a failed version instead.
   */
  mark: Schema.NullOr(Schema.Literals(["refused"])),
  /**
   * For text whose macros resolve on display (a greeting): the values its random and time
   * macros drew when it was made, so it reads the same every time (DESIGN §5.6).
   */
  frozenMacros: Schema.NullOr(FrozenMacros),
  /**
   * For a generated version, the context it was generated from: null when none was
   * recorded. The request inspector reads it whole (inspectorApi.ts).
   */
  context: Schema.NullOr(Schema.Struct({ issues: Schema.Array(ContextIssue) })),
  /**
   * Optimistic concurrency for amending a user-written version: one more than the number
   * of times it was amended, counted from its kept history (version_history).
   */
  rowVersion: Schema.Int
}) {}

/** One position on a path, with the version selected there. */
export class PathEntry extends Schema.Class<PathEntry>("PathEntry")({
  slotId: SlotId,
  laneId: LaneId,
  parentSlotId: Schema.NullOr(SlotId),
  depth: Schema.Int,
  rowVersion: Schema.Int,
  contextExcluded: Schema.Boolean,
  /** Excluded because the user hid it here (SetMessageHidden), not because an import brought it hidden. */
  hiddenByUser: Schema.Boolean,
  version: Version,
  versionCount: Schema.Int,
  /**
   * The alternate branches at this position (DESIGN §3.2): the slot and its siblings in
   * its lane, those a path can reach (live, or deleted alone with replies left), and this
   * slot's place among them, oldest first.
   */
  branchCount: Schema.Int,
  branchIndex: Schema.Int,
  /**
   * The name of the branch this slot starts among its alternates: its own label (from an
   * ST import, or one given before forks), else the name of the fork it starts; absent: unnamed.
   */
  branchName: Schema.optionalKey(Schema.String),
  /** The fork that appended it; absent for one from before forks, or an ST import's. */
  forkId: Schema.optionalKey(ForkId),
  /** The fork whose first message this is (NameFork names it); absent when it starts none. */
  startsForkId: Schema.optionalKey(ForkId),
  /**
   * The fork whose choices it shows: its version, row version and context are as that fork
   * has them (spec/FORK-INDEPENDENCE-DELTA.md §2.2). A tab showing another fork reads the
   * slot again instead of taking this one.
   */
  shownForkId: Schema.optionalKey(ForkId),
  /**
   * Its index on the fork's display path, from 0 at the first message: the path with the
   * messages the fork inserted, which number from here (spec/MESSAGE-INSERT.md §2.3). `depth`
   * stays the structural one. Set on path windows (GetPath, ReadPath); absent elsewhere.
   */
  position: Schema.optionalKey(Schema.Int),
  /**
   * The side the message is on when its speaker isn't one of the cast, as the context reads
   * it (assemblySources.ts): its first version's, deleted or not, so which versions are
   * live never changes it. A human's first version is the user's, unless it's a greeting.
   */
  side: Schema.Literals(["user", "assistant"]),
  /**
   * Who its first version, deleted or not, names as the speaker: whom the message shows as
   * when no live version names anyone (one written before written versions kept the speaker).
   */
  firstSpeakerEntityId: Schema.NullOr(EntityId),
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
  images: Schema.optionalKey(MessageImages),
  status: VersionStatus,
  macroMode: MacroMode,
  origin: VersionOrigin,
  sourceVersionId: Schema.optional(VersionId),
  /** For a greeting: which of its card's greetings it is (0: `first_mes`), so it can follow the card. */
  greetingRef: Schema.optional(Schema.Struct({ entity: EntityId, index: Schema.Int })),
  /** For a template: the values its volatile macros drew when it was shown, kept (DESIGN §5.6). */
  frozenMacros: Schema.optional(FrozenMacros),
  direction: Schema.optional(Schema.String),
  /** A continued version starts with the reasoning of the version it continues. */
  reasoning: Schema.optional(Schema.String),
  /** Required for failed versions: what went wrong (DESIGN §3.1). */
  error: Schema.optional(
    Schema.Struct({ class: Schema.String, message: Schema.String, detail: Schema.optional(Schema.Unknown) })
  )
}) {}

/** A version is usable in context when it has text and didn't fail (invariant 2). */
export const versionInContext = (status: VersionStatus, content: string, contextExcluded: boolean, imageCount = 0) =>
  !contextExcluded && status !== "failed" && (content.length > 0 || imageCount > 0)

// --- Chat setup, speakers and the send queue (DESIGN §2.1, §2.2)

/** A card as a chat shows it, from the revision selected by its binding. */
export class CastCard extends Schema.Class<CastCard>("CastCard")({
  entityId: EntityId,
  /** The card document's display name. */
  name: Schema.String,
  /** CCv3 nickname, falling back to name, for template expansion. */
  modelName: Schema.optionalKey(Schema.String),
  /** The card revision's character_version. */
  subtitle: Schema.optionalKey(Schema.String),
  /** Derived display name, retained for existing library consumers. */
  label: Schema.String,
  /** In the persona folder (DESIGN §2.2). */
  persona: Schema.Boolean,
  /** In the recycle bin: still named where a chat refers to it, but not offered. */
  inBin: Schema.Boolean,
  /** It carries its own lorebook (`character_book`), which a chat can turn off. */
  lorebook: Schema.Boolean,
  /** That lorebook's own name (`character_book.name`), when it has one. */
  lorebookName: Schema.optionalKey(Schema.String),
  /** How many entries that lorebook has. */
  lorebookEntries: Schema.optionalKey(Schema.Int),
  /** Its avatar, served at `/library/media?id=`; null without one. */
  avatarMediaId: Schema.NullOr(Schema.String)
}) {}

/** What the chat list shows of a chat besides its title (DESIGN §2.1). */
export class ChatSummary extends Schema.Class<ChatSummary>("ChatSummary")({
  chatId: ChatId,
  /** Everyone who joined the chat, in join order, with their cards. */
  cast: Schema.Array(CastCard),
  /** Messages on the active path. */
  messages: Schema.Int,
  /** The active path's last message: who spoke it and its start. */
  last: Schema.NullOr(Schema.Struct({ speaker: Schema.NullOr(EntityId), writer: Schema.String, text: Schema.String }))
}) {}

/**
 * A message sent, or a reply asked for, while the reply it follows is still being
 * written (DESIGN §2.2). The server holds it and posts it when that reply ends.
 */
export class QueuedMessage extends Schema.Class<QueuedMessage>("QueuedMessage")({
  id: Schema.String,
  chatId: ChatId,
  /** The reply it waits for: posting goes under this slot, after its selected version. */
  replySlotId: SlotId,
  /** A message to post (then a reply to it), or a reply to generate. */
  kind: Schema.Literals(["message", "generate"]),
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  speakerEntityId: Schema.NullOr(EntityId),
  /** For `message`: who replies to it once it posts, as for a send made then. */
  replySpeakerEntityId: Schema.NullOr(EntityId),
  /** For `generate`: the one-turn direction the reply gets. */
  direction: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  createdAt: Schema.Number
}) {}
