// Merging another chat into this one (spec/CHAT-MERGE.md; owner decisions DESIGN §3.3,
// 2026-11-05). The destination is the chat the user is in; the source is only read. The RPCs
// are their own group, merged into AppApi like the split-chat group.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat, ChatId, EntityId, ForkId, PathEntry, SlotId } from "./chat.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { HistoryRejected } from "./historyApi.ts"

/** The layouts the built-in assembler registers (`Assembler.mergeLayouts`); plugins add others. */
export const MERGE_LAYOUT_DEFAULT = "parallel"

/** The preset's framing line when a merge has none of its own (`utility.merge_section_prompt`). */
export const MERGE_SECTION_DEFAULT = "Meanwhile, in parallel with what follows: {{title}}, with {{cast}}."
/** What the layout sends at the join (`utility.merge_join_prompt`). */
export const MERGE_JOIN_DEFAULT = "[Here “{{title}}” joins this chat.]"

/** A merge template with its two placeholders filled; nothing else in it expands. */
export const fillMergeTemplate = (template: string, title: string, cast: ReadonlyArray<string>) =>
  template.replace(/\{\{title\}\}/gi, title).replace(/\{\{cast\}\}/gi, castList(cast))

const castList = (names: ReadonlyArray<string>) =>
  names.length === 0
    ? "nobody"
    : names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`

/**
 * What to merge: the source fork, the destination message to merge below (`at`, null: the
 * fork's newest), and for chats that share nothing, the destination message the parallel span
 * starts at (`start`; absent: the merge position). `includeLeftOut` brings the older source
 * messages that have no summary as written instead of leaving them out.
 */
export const MergeRequest = Schema.Struct({
  chatId: ChatId,
  forkId: ForkId,
  at: Schema.NullOr(SlotId),
  source: Schema.Struct({ chatId: ChatId, forkId: ForkId }),
  start: Schema.optionalKey(Schema.NullOr(SlotId)),
  includeLeftOut: Schema.Boolean
})
export type MergeRequest = typeof MergeRequest.Type

export const MergeCastMember = Schema.Struct({
  entity: EntityId,
  name: Schema.String,
  avatarMediaId: Schema.NullOr(Schema.String),
  /** Not in the destination's cast at the merge point: the merge adds it. */
  added: Schema.Boolean
})

/** What a merge would bring, computed the same way the write does it (spec §3). */
export class ChatMergePreview extends Schema.Class<ChatMergePreview>("ChatMergePreview")({
  /** The source's title: its branch's name, else its chat's title. */
  sourceTitle: Schema.String,
  /** The source is a branch of the same chat (split chats included). */
  sameChat: Schema.Boolean,
  /** Messages both share, from the first (0 for chats that share nothing). */
  shared: Schema.Int,
  /** It continues an earlier merge of the same source: only what's new since then comes in. */
  continues: Schema.Boolean,
  /** The source's message number (one-based) the merged part starts at. */
  from: Schema.Int,
  /** Source messages after the base, and how they come in. */
  messages: Schema.Int,
  verbatim: Schema.Int,
  summarized: Schema.Int,
  summaries: Schema.Int,
  leftOut: Schema.Int,
  leftOutTokens: Schema.Int,
  /** The merged text's size, the budget it was fitted to, and the destination's parallel span. */
  tokens: Schema.Int,
  budget: Schema.Int,
  spanTokens: Schema.Int,
  /** The destination message the join goes below, and its one-based number. */
  at: Schema.Struct({ slotId: SlotId, number: Schema.Int }),
  /** Where the parallel span starts in the destination; null: directly before the join. */
  start: Schema.NullOr(Schema.Struct({ slotId: SlotId, number: Schema.Int })),
  cast: Schema.Array(MergeCastMember),
  /** The framing line with this merge's title and cast, from the built-in default. */
  framing: Schema.String,
  /** What the model reads of the source (the join message's text). */
  section: Schema.String,
  /** The join marker as the built-in default renders it. */
  join: Schema.String,
  /** A summary covering the merge position, written again with the next reply (numbers, one-based). */
  rewrites: Schema.NullOr(Schema.Struct({ from: Schema.Int, to: Schema.Int, tokens: Schema.Int })),
  /** Changes when anything the merge reads changes; the write compares it. */
  digest: Schema.String
}) {}

/** The source or the destination changed since the preview: here is the new one. */
export class MergeChanged extends Schema.TaggedError<MergeChanged>()("MergeChanged", {
  preview: ChatMergePreview
}) {}

/** A merge that can't be made (nothing new, the same branch, an empty chat). */
export class MergeRefused extends Schema.TaggedError<MergeRefused>()("MergeRefused", {
  message: Schema.String
}) {}

export const MergeChatInput = Schema.Struct({
  ...MergeRequest.fields,
  title: Schema.String,
  /** This merge's framing line; null: the preset's (`utility.merge_section_prompt`). */
  framing: Schema.NullOr(Schema.String),
  digest: Schema.String
})
export type MergeChatInput = typeof MergeChatInput.Type

export class MergedChat extends Schema.Class<MergedChat>("MergedChat")({
  entry: PathEntry,
  chat: Chat
}) {}

/** A merge as the timeline shows it. */
export class MergeInfo extends Schema.Class<MergeInfo>("MergeInfo")({
  id: Schema.String,
  slotId: SlotId,
  title: Schema.String,
  sourceChatId: Schema.NullOr(ChatId),
  sourceForkId: Schema.NullOr(ForkId),
  /** The source still exists and isn't in the bin. */
  sourceLive: Schema.Boolean,
  messages: Schema.Int,
  verbatim: Schema.Int,
  summarized: Schema.Int,
  leftOut: Schema.Int,
  cast: Schema.Array(Schema.String),
  createdAt: Schema.Number
}) {}

export const MergedMessage = Schema.Struct({
  ordinal: Schema.Int,
  kind: Schema.Literals(["message", "summary"]),
  speakerEntityId: Schema.NullOr(EntityId),
  speakerName: Schema.String,
  side: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
  sentAt: Schema.Number,
  /** How the model reads it: as written, through a summary, or not at all. */
  included: Schema.Literals(["verbatim", "summarized", "left_out"])
})
export type MergedMessage = typeof MergedMessage.Type

export class ChatMergeApi extends RpcGroup.make(
  /** What merging `source` into the fork below `at` would bring; nothing is written or sent. */
  Rpc.make("PreviewChatMerge", {
    payload: MergeRequest,
    success: ChatMergePreview,
    error: Schema.Union([NotFound, MergeRefused, StaleWrite, ServerError])
  }),
  /**
   * Merges as previewed (`digest`), in one transaction: the join message below `at`, the cast
   * union, the frozen copy of the merged messages. It's the registered command `chat.merge`.
   */
  Rpc.make("MergeChat", {
    payload: MergeChatInput,
    success: MergedChat,
    error: Schema.Union([NotFound, MergeRefused, MergeChanged, StaleWrite, HistoryRejected, ServerError])
  }),
  Rpc.make("GetMerge", {
    payload: { chatId: ChatId, slotId: SlotId },
    success: MergeInfo,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("MergeMessages", {
    payload: {
      chatId: ChatId,
      mergeId: Schema.String,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
    },
    success: Schema.Array(MergedMessage),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
