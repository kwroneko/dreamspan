import { ChatId, SlotId, ForkId } from "./chatPosition.ts"
export { ChatId, SlotId, ForkId, StoryAt, StoryAtField } from "./chatPosition.ts"
// The message graph as the rest of the app sees it (DATA-MODEL.md §4).
import { Schema } from "effect"
import { StepsSummary } from "./agent.ts"
import { AvatarCrop } from "./media.ts"
import { idSchema } from "./id.ts"
import { StoredRewrite, VersionRewrite } from "./regexScripts.ts"
import { ReplySections } from "./replySections.ts"

export const VersionId = idSchema("VersionId", "version")
export type VersionId = typeof VersionId.Type
export const EntityId = idSchema("EntityId", "entity")
export type EntityId = typeof EntityId.Type

// Membership is validated by the writer's scoped storageKinds registry.
export const ChatKind = Schema.String
const ChatStatus = Schema.Literals(["pending", "active", "archived"])
export const VersionStatus = Schema.Literals(["generating", "complete", "stopped", "failed", "interrupted"])
export type VersionStatus = typeof VersionStatus.Type
const Writer = Schema.Literals(["human", "model"])
const MacroMode = Schema.Literals(["template", "verbatim"])
// The writer validates origins against its replaceable storage-kind registry.
const VersionOrigin = Schema.String

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
  lastMessageAt: Schema.NullOr(Schema.Number),
  /** The chat's own picture (SetChatPicture), a media id; absent: its characters' faces. */
  pictureMediaId: Schema.optionalKey(Schema.String)
}) {}

/**
 * Where a fork parts from the fork it was made from (owner, 2026-11-01): `at`, the time of its
 * first own message, else of its making; `after`, how many shown messages the two share before
 * it ("at #14" when it's 14). What names a branch the user hasn't named (`forkLabel`).
 */
export const ForkSplit = Schema.Struct({ at: Schema.Number, after: Schema.Int })
export type ForkSplit = typeof ForkSplit.Type

/**
 * A fork's place in one set of parallel threads (spec/THREADS.md §4.3): the split, and which
 * of its threads it's in (0: the branch they were started in, continuing). See threads.ts.
 */
export const ThreadPlace = Schema.Struct({ splitId: Schema.String, ordinal: Schema.Int })
export type ThreadPlace = typeof ThreadPlace.Type

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
  /** Navigation target, including inferred imported split points (ListForks). */
  startSlotId: Schema.optionalKey(Schema.NullOr(SlotId)),
  /** Where its path ends; null before its first message. */
  tipSlotId: Schema.NullOr(SlotId),
  name: Schema.NullOr(Schema.String),
  pinnedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  lastChattedAt: Schema.NullOr(Schema.Number),
  /** Latest usable message preview on the branch; empty without text. */
  tipExcerpt: Schema.String,
  /** It's the chat's current fork (`Chat.currentForkId`). */
  current: Schema.Boolean,
  rowVersion: Schema.Int,
  /** Where it parts from its parent (ListForks); null for the chat's first fork. */
  split: Schema.optionalKey(Schema.NullOr(ForkSplit)),
  /** Its last shown message's time (ListForks); null without one. */
  endAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** The thread sets it's in, innermost first (ListForks; spec/THREADS.md §4.3); absent when none. */
  threads: Schema.optionalKey(Schema.Array(ThreadPlace))
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
export const VersionError = Schema.Struct({
  class: Schema.String,
  message: Schema.String,
  /** A context-length error's stated limit, and the model it was stated for, to save it there. */
  contextLimit: Schema.optionalKey(Schema.Struct({ tokens: Schema.Int, modelId: Schema.String }))
})

/**
 * A version's thinking, as the user can hide it from the model: the provider's reasoning, or
 * the thinking captured from the reply by the preset's tags (spec/REPLY-SECTIONS.md).
 */
export const ThinkingPart = Schema.Literals(["reasoning", "sections"])
export type ThinkingPart = typeof ThinkingPart.Type

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
    "plugin_replacement",
    "history_truncated",
    "summary_failed",
    "summary_model_unavailable",
    "examples_truncated",
    "regex_skipped",
    "lorebook_issue",
    // Recorded by contexts assembled before version 30; never shown (ARCHITECTURE §15).
    "last_turn_filled",
    "layout_ignored",
    "cache_breakpoints",
    "role_projection_missing",
    "merge_layout_missing",
    // Separate contexts (spec/CHARACTER-CONTEXT.md §9.2 C3).
    "context_view_missing",
    "summaries_withheld",
    "note_replacement",
    "compatibility",
    // Thinking kept out of a request: hidden by the user, or signed thinking the provider would refuse.
    "thinking_left_out",
    // Earlier replies' reasoning the preset sends back but this request couldn't: inspector only.
    "reasoning_left_out"
  ]),
  message: Schema.String
})
export type ContextIssue = typeof ContextIssue.Type

/**
 * Ordered, version-owned attachments: images, and in workshops files of any type
 * (spec/FILES-AND-ENVIRONMENT.md §6.1). Bytes are uploaded separately. An attachment saved in
 * Files has its `name` and `path` there; `kind: "file"` marks one that isn't an image, which is
 * never sent as an image (`imagesOnly`).
 */
export const MessageImages = Schema.Array(
  Schema.Struct({
    mediaId: Schema.String,
    altText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
    kind: Schema.optionalKey(Schema.Literals(["file"])),
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
    path: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    /**
     * A character card attached as a file (spec/WORKSHOP-CARDS.md §4.5): its name and format, as
     * the server read them when it was attached. Read only: what a client sends here is ignored.
     */
    card: Schema.optionalKey(Schema.Struct({ name: Schema.String, format: Schema.Literals(["png", "json", "charx"]) }))
  })
).check(Schema.isMaxLength(32))
export type MessageImages = typeof MessageImages.Type

/**
 * Library items attached to a workshop message (spec/WORKSHOP-CARDS.md §4): cards, lorebooks and
 * presets the assistant may read and change from that message on. The server records the
 * revision each was at when sent (`version_library`). `RefId` is library.ts's, declared again
 * here because library.ts imports this module.
 */
export const MessageLibrary = Schema.Array(
  Schema.Struct({ kind: Schema.Literals(["card", "lorebook", "preset"]), refId: idSchema("RefId", "ref") })
).check(Schema.isMaxLength(16))
export type MessageLibrary = typeof MessageLibrary.Type

/** A message's library items as recorded at send, with each one's name then: what its tiles show. */
export const VersionLibrary = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(["card", "lorebook", "preset"]),
    refId: idSchema("RefId", "ref"),
    name: Schema.String
  })
)
export type VersionLibrary = typeof VersionLibrary.Type

/** The images of a set of attachments, leaving out files of other types. */
export const imagesOnly = <A extends { readonly kind?: "file" }>(attachments: ReadonlyArray<A>): ReadonlyArray<A> =>
  attachments.filter((a) => a.kind !== "file")

/**
 * How a version was generated, as the app it was imported from recorded it (SillyTavern's
 * `gen_started`, `gen_finished` and `extra`: `token_count`, `time_to_first_token`,
 * `reasoning_duration`). Versions this app generates have theirs in the usage ledger instead
 * (`GetVersionMetrics`, inspectorApi.ts). Each figure is absent where none was recorded.
 */
export const RecordedGeneration = Schema.Struct({
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
  /** ST's own count of the text with its reasoning, by the tokenizer it had set; not a provider's. */
  tokens: Schema.optionalKey(Schema.Int),
  firstTokenMs: Schema.optionalKey(Schema.Number),
  reasoningMs: Schema.optionalKey(Schema.Number),
  /**
   * How its reasoning came to be, where ST recorded it as the user's (`extra.reasoning_type`):
   * `edited` (the model's, edited) or `manual` (added). Absent: the model's or parsed.
   */
  reasoningType: Schema.optionalKey(Schema.Literals(["edited", "manual"]))
})
export type RecordedGeneration = typeof RecordedGeneration.Type

/**
 * Which model wrote a version, as its icon is chosen: the provider (a connection's kind, or
 * the API SillyTavern recorded, such as "openrouter" or "claude") and the model's key as that
 * provider names it (either may be empty).
 */
export const ModelRef = Schema.Struct({ provider: Schema.String, model: Schema.String })
export type ModelRef = typeof ModelRef.Type

/**
 * How a reply's speaker was chosen, when the decision model's "Who replies next" was to choose
 * it (DESIGN §2.3, spec/AGENTIC.md §7): `auto`, not chosen yet (the speaker is Auto's pick, which
 * the reply never shows as its speaker meanwhile); `order`, Auto's pick stood (nothing to ask, or
 * no answer sure enough); `decision`, the decision model's pick, with how sure it was and the name
 * it was asked about. Absent: Auto's or the user's pick, with no decision model involved.
 */
export const SpeakerPick = Schema.Union([
  Schema.Struct({ by: Schema.Literal("auto") }),
  Schema.Struct({ by: Schema.Literal("order") }),
  Schema.Struct({
    by: Schema.Literal("decision"),
    confidence: Schema.Number,
    name: Schema.String,
    rolloutId: Schema.String
  })
])
export type SpeakerPick = typeof SpeakerPick.Type

export class Version extends Schema.Class<Version>("Version")({
  id: VersionId,
  slotId: SlotId,
  ordinal: Schema.Int,
  status: VersionStatus,
  speakerEntityId: Schema.NullOr(EntityId),
  speakerPick: Schema.optionalKey(SpeakerPick),
  writer: Writer,
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  /** The cards, lorebooks and presets a workshop message carries (spec/WORKSHOP-CARDS.md §4.2). */
  library: Schema.optionalKey(VersionLibrary),
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
   * the start for an explicit model override, otherwise once its context is assembled. For an
   * imported version, the API and model SillyTavern recorded, as "API · model" (such as
   * "OpenRouter · anthropic/claude-3.5-sonnet"): its models aren't the user's connections.
   * Null for text a person wrote, and where nothing was recorded.
   */
  model: Schema.NullOr(Schema.String),
  /** The provider and model key behind `model`, for its icon; absent where none is recorded. */
  modelRef: Schema.optionalKey(ModelRef),
  /** An imported version's generation figures, as its app recorded them; absent otherwise. */
  recorded: Schema.optionalKey(RecordedGeneration),
  /** Set on failed versions only. */
  error: Schema.NullOr(VersionError),
  /**
   * The reasoning ("thinking") the model streamed before or beside its text, kept as it came
   * and shown apart from it. Sent back only where the preset says and the provider takes it
   * (ARCHITECTURE §15, "Reasoning sent back"). Absent without any.
   */
  reasoning: Schema.optionalKey(Schema.String),
  /**
   * Tagged sections the reply began with, taken out of `content` (spec/REPLY-SECTIONS.md):
   * shown in a panel of their own, sent back only as the preset says. Absent without any.
   */
  replySections: Schema.optionalKey(ReplySections),
  /**
   * A judge model read this version's text and found a refusal (spec/LCM.md §2.4). The text
   * stays; a provider's own refusal makes a failed version instead. `silent`: the replying
   * character passed (`no_reply`, spec/REPLY-CONTRACT.md §3.1): no text, shown as a line
   * "<Name> stays silent", and another version of it is an actual reply.
   */
  mark: Schema.NullOr(Schema.Literals(["refused", "silent"])),
  /**
   * What regex scripts did to its text when it was written (ARCHITECTURE §12, "Rewrites"):
   * absent when none applied or failed.
   */
  rewrite: Schema.optionalKey(VersionRewrite),
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
  /** An agent rollout's tool calls and run time (spec/AGENTIC.md §5.1); absent without steps. */
  steps: Schema.optionalKey(StepsSummary),
  /**
   * Written by an agent run (a reply with tools), with or without steps: one that stopped or
   * failed can be resumed (spec/AGENTIC.md §5.2). Absent otherwise.
   */
  agent: Schema.optionalKey(Schema.Boolean),
  /**
   * Optimistic concurrency for amending a user-written version: one more than the number
   * of times it was amended, counted from its kept history (version_history).
   */
  rowVersion: Schema.Int
}) {}

/** One position on a path, with the version selected there. */
export class PathEntry extends Schema.Class<PathEntry>("PathEntry")({
  slotId: SlotId,
  parentSlotId: Schema.NullOr(SlotId),
  depth: Schema.Int,
  rowVersion: Schema.Int,
  contextExcluded: Schema.Boolean,
  /** Excluded because the user hid it here (SetMessageHidden), not because an import brought it hidden. */
  hiddenByUser: Schema.Boolean,
  /** The media ids of its version's images taken out of the context here (SetImageExcluded); absent: none. */
  excludedImages: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Its version's thinking hidden from the model here (SetThinkingHidden); absent: none. */
  hiddenThinking: Schema.optionalKey(Schema.Array(ThinkingPart)),
  version: Version,
  versionCount: Schema.Int,
  /**
   * The alternate branches at this position (DESIGN §3.2): the slot and its siblings in
   * its chat, those a path can reach (live, or deleted alone with replies left), and this
   * slot's place among them, oldest first.
   */
  branchCount: Schema.Int,
  branchIndex: Schema.Int,
  /**
   * The name of the fork this slot starts among its alternates; absent: unnamed.
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
   * Inserted between messages (spec/MESSAGE-INSERT.md §2.2). It's never the fork's tip: a
   * message added at the end goes below the tip, even when an inserted one shows last. Absent:
   * not inserted.
   */
  inserted: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Its copies in other threads when it was sent to several (spec/THREADS.md §6.3): each copy's
   * message and the fork that posted it, while both are live. Absent: none.
   */
  copies: Schema.optionalKey(Schema.Array(Schema.Struct({ slotId: SlotId, forkId: ForkId }))),
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
  /** A reply whose speaker Auto picked: the decision model may choose another before it's written. */
  speakerPick: Schema.optional(SpeakerPick),
  writer: Writer,
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  /** Library items a workshop message carries (spec/WORKSHOP-CARDS.md §4); absent: none, or its source's. */
  library: Schema.optionalKey(MessageLibrary),
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
  /** What regex scripts did to `content` before it was written, and the text before (server only). */
  rewrite: Schema.optional(StoredRewrite),
  /** And with its reply sections. */
  replySections: Schema.optional(ReplySections),
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
  /** Its chance 0..1 to reply in a group's automatic pick (`extensions.talkativeness`; 0.5 when unset). */
  talkativeness: Schema.Number,
  /** It carries its own lorebook (`character_book`), which a chat can turn off. */
  lorebook: Schema.Boolean,
  /** That lorebook's own name (`character_book.name`), when it has one. */
  lorebookName: Schema.optionalKey(Schema.String),
  /** How many entries that lorebook has. */
  lorebookEntries: Schema.optionalKey(Schema.Int),
  /** The world file it names (`extensions.world`), which replaces that lorebook when a chat reads a file of that name. */
  lorebookWorld: Schema.optionalKey(Schema.String),
  /** Its avatar, served at `/library/media?id=`; null without one. */
  avatarMediaId: Schema.NullOr(Schema.String),
  /** The avatar's chosen cutout (ARCHITECTURE.md §14.5c); absent: the default. */
  avatarCrop: Schema.optionalKey(AvatarCrop)
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
  /** Library items the message carries once it posts (a workshop's, spec/WORKSHOP-CARDS.md §4). */
  library: Schema.optionalKey(MessageLibrary),
  speakerEntityId: Schema.NullOr(EntityId),
  /** For `message`: who replies to it once it posts, as for a send made then. */
  replySpeakerEntityId: Schema.NullOr(EntityId),
  /** For `generate`: the one-turn direction the reply gets. */
  direction: Schema.NullOr(Schema.String),
  /**
   * A reply of a round (DESIGN §2.3): queued by the server, behind the round's reply before it,
   * in `forkId`. `held`: the round stopped (Stop, or a reply that failed) and waits for
   * Continue round. `decides`: the decision model chooses who replies at this turn, so its
   * speaker is only Auto's fallback. `startSlotId`: the round's first reply, once posted.
   */
  round: Schema.optionalKey(
    Schema.Struct({
      held: Schema.Boolean,
      forkId: Schema.NullOr(ForkId),
      decides: Schema.optionalKey(Schema.Boolean),
      startSlotId: Schema.optionalKey(SlotId)
    })
  ),
  rowVersion: Schema.Int,
  createdAt: Schema.Number
}) {}
