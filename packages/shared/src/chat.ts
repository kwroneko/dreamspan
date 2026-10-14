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
    "macro_limit",
    "history_truncated",
    "summary_failed",
    "examples_truncated",
    "regex_skipped",
    "lorebook_issue"
  ]),
  message: Schema.String
})
export type ContextIssue = typeof ContextIssue.Type

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
  /** The name the user gave the branch this slot starts among its alternates (NameBranch); absent: unnamed. */
  branchName: Schema.optionalKey(Schema.String),
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
  status: VersionStatus,
  macroMode: MacroMode,
  origin: VersionOrigin,
  sourceVersionId: Schema.optional(VersionId),
  /** For a greeting: which of its card's greetings it is (0: `first_mes`), so it can follow the card. */
  greetingRef: Schema.optional(Schema.Struct({ entity: EntityId, index: Schema.Int })),
  /** For a template: the values its volatile macros drew when it was shown, kept (DESIGN §5.6). */
  frozenMacros: Schema.optional(FrozenMacros),
  direction: Schema.optional(Schema.String),
  /** Required for failed versions: what went wrong (DESIGN §3.1). */
  error: Schema.optional(
    Schema.Struct({ class: Schema.String, message: Schema.String, detail: Schema.optional(Schema.Unknown) })
  )
}) {}

/** A version is usable in context when it has text and didn't fail (invariant 2). */
export const versionInContext = (status: VersionStatus, content: string, contextExcluded: boolean) =>
  !contextExcluded && status !== "failed" && content.length > 0

// --- Chat setup, speakers and the send queue (DESIGN §2.1, §2.2)

/** A card as a chat shows it: its in-chat name (`{{char}}`), its library label, its folders. */
export class CastCard extends Schema.Class<CastCard>("CastCard")({
  entityId: EntityId,
  /** The name in the card's document, which is what the chat shows and macros use. */
  name: Schema.String,
  /** The library label, for telling apart cards with the same name. */
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
  speakerEntityId: Schema.NullOr(EntityId),
  /** For `message`: who replies to it once it posts, as for a send made then. */
  replySpeakerEntityId: Schema.NullOr(EntityId),
  /** For `generate`: the one-turn direction the reply gets. */
  direction: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  createdAt: Schema.Number
}) {}
