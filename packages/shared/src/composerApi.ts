// The composer's text on the server (DESIGN §6.2, DATA-MODEL §10), merged into AppApi. Each
// fork of a chat has its own composer, a draft with server-side undo history: saved while
// the user types, read back on a reload or another device, committed with the send.
//
// The client names the draft its text was typed into (its id, row version and session),
// never just the fork: the server saves the text onto that draft (ARCHITECTURE §3.10).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, ForkId, SlotId } from "./chat.ts"
import { Draft, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { RefId } from "./library.ts"

/** Text past the drafts' cap (DraftHistoryPolicy.maxContentChars); nothing was saved. */
export class TextTooLong extends Schema.TaggedError<TextTooLong>()("TextTooLong", {
  length: Schema.Int,
  max: Schema.Int
}) {}

const Errors = [NotFound, ServerError] as const

/**
 * The composer’s Guidance mode, speaker and next-reply pick (DESIGN §2.2), kept with its
 * draft per chat and fork. A reload or another device finds the same choices.
 */
export class ComposerChoice extends Schema.Class<ComposerChoice>("ComposerChoice")({
  draftId: Schema.String,
  /** Whether this composer’s text directs the model instead of sending a message. */
  guidance: Schema.Boolean,
  /** The card picked to speak as; null until one is, when the composer picks its default. */
  speakerEntityId: Schema.NullOr(EntityId),
  /** Who replies to the next send, picked for that one reply; null: the next in turn. */
  replyFromEntityId: Schema.NullOr(EntityId),
  /** Next is No one: a send asks for no reply, until another choice under Next (DESIGN §2.3). */
  noReplies: Schema.Boolean,
  /**
   * The reply this composer's text is the guidance for while a new version of it is written
   * (DESIGN §2.2, guidance on swipes); null: new turns. Absent where a write didn't touch it.
   */
  guidanceSlotId: Schema.optionalKey(Schema.NullOr(SlotId))
}) {}

/**
 * Text typed into a composer: the draft it was typed into, as the client last had it, and
 * the text now. Also what a closing page sends with the editors' drafts (`composers` in
 * `POST /library/drafts`, with keepalive).
 */
export const ComposerBeacon = Schema.Struct({
  chatId: ChatId,
  draftId: Schema.String,
  rowVersion: Schema.Int,
  session: Schema.Int,
  /**
   * Typed after a send of this session that may not have arrived (a page closing while it
   * was out): it starts the session that send ends, or goes on top of the text it takes.
   */
  next: Schema.Boolean,
  /** Durable pending-copy identity: replay acknowledges it without applying the text again. */
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  content: Schema.String
})

export const ComposerSaveResult = Schema.Struct({
  draft: Schema.NullOr(Draft),
  recovered: Schema.Boolean,
  /** The save was accepted into the session the returned draft is still in. */
  accepted: Schema.Boolean
})

export const ComposerImage = Schema.Struct({
  position: Schema.Int,
  id: Schema.String,
  mediaId: Schema.NullOr(Schema.String),
  altText: Schema.String,
  status: Schema.Literals(["active", "sent", "removed"]),
  /** A workshop's attachment saved in Files (§6.1): `file` for one that isn't an image, its name and path. */
  kind: Schema.optionalKey(Schema.Literals(["file"])),
  name: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  /** A character card file (spec/WORKSHOP-CARDS.md §4.5): its name and format. */
  card: Schema.optionalKey(Schema.Struct({ name: Schema.String, format: Schema.Literals(["png", "json", "charx"]) }))
})
export type ComposerImage = typeof ComposerImage.Type
export const ComposerImageKey = { chatId: ChatId, draftId: Schema.String }
/** A composer image slot to fill with a Files copy in the same write. */
export const AttachmentComposer = Schema.Struct({
  ...ComposerImageKey,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
})
export type AttachmentComposer = typeof AttachmentComposer.Type
export const ComposerImageIds = Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
  Schema.isMaxLength(32)
)
export const SetComposerImageFields = {
  ...AttachmentComposer.fields,
  mediaId: Schema.NullOr(Schema.String),
  altText: Schema.String.check(Schema.isMaxLength(2000)),
  kind: Schema.optionalKey(Schema.Literals(["file"])),
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)))
}

/**
 * A card, lorebook or preset attached to a workshop's composer and not sent yet
 * (spec/WORKSHOP-CARDS.md §4.4), with its name in the library now.
 */
export const ComposerLibraryItem = Schema.Struct({
  kind: Schema.Literals(["card", "lorebook", "preset"]),
  refId: RefId,
  name: Schema.String
})
export type ComposerLibraryItem = typeof ComposerLibraryItem.Type
const ComposerLibraryHandover = Schema.Struct({
  originChatId: ChatId,
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
})
export type ComposerLibraryHandover = typeof ComposerLibraryHandover.Type
export const SetComposerLibraryFields = {
  ...ComposerImageKey,
  /** Attached after those there, by id (the server knows each one's kind); one already there stays where it is. */
  add: Schema.Array(RefId).check(Schema.isMaxLength(16)),
  remove: Schema.Array(RefId).check(Schema.isMaxLength(16)),
  /**
   * A new chat swept (`chatId` opened in its place) whose handed-over items `add` carries on:
   * only those its composer still held and that another replacement hasn't taken are attached.
   */
  carriedFrom: Schema.optionalKey(Schema.String),
  /** A pending URL's operation, used to find the source when no swept workshop is named. */
  handover: Schema.optionalKey(ComposerLibraryHandover)
}

export class ComposerApi extends RpcGroup.make(
  Rpc.make("GetComposerImages", {
    payload: { ...ComposerImageKey, ids: ComposerImageIds },
    success: Schema.Array(ComposerImage),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("SetComposerImage", {
    payload: SetComposerImageFields,
    success: ComposerImage,
    error: Schema.Union([...Errors])
  }),
  /**
   * The composer of a fork of the chat (null: its current fork), made empty if there's
   * none. `copyFrom` (a composer draft's id) starts a branch: its text is copied in, unless
   * this fork has text of its own (DESIGN §6.2).
   */
  Rpc.make("OpenComposer", {
    payload: { chatId: ChatId, forkId: Schema.NullOr(ForkId), copyFrom: Schema.optionalKey(Schema.String) },
    success: Draft,
    error: Schema.Union([...Errors])
  }),
  /**
   * Saves what's typed (debounced by the client) onto the draft it was typed into. Another
   * tab's newer text stays one step back in the history. If that draft's text was sent or
   * discarded since, or the draft is gone, the text goes to the bin's recovered texts
   * instead (`recovered`), and `draft` is the draft as it is now (null if gone).
   */
  Rpc.make("SaveComposer", {
    payload: ComposerBeacon.fields,
    success: ComposerSaveResult,
    error: Schema.Union([...Errors, TextTooLong])
  }),
  /** The restorable states of the composer draft's text, newest first. */
  Rpc.make("ComposerHistory", {
    payload: {
      chatId: ChatId,
      draftId: Schema.String,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  /** Moves the text back to an earlier state; the restore can be undone too. */
  Rpc.make("RestoreComposer", {
    payload: { chatId: ChatId, draftId: Schema.String, ...DraftRestore },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** The speaker and reply choice kept with a composer draft. */
  Rpc.make("GetComposerChoice", {
    payload: { chatId: ChatId, draftId: Schema.String },
    success: ComposerChoice,
    error: Schema.Union([...Errors])
  }),
  /**
   * Changes what's given of the speaker and the reply choice (null clears it) and publishes
   * the result to the chat's subscribers (`ComposerChoice`), so every open tab shows it. A
   * choice, not text: the last one made wins, with no history.
   */
  Rpc.make("SetComposerChoice", {
    payload: {
      chatId: ChatId,
      draftId: Schema.String,
      guidance: Schema.optionalKey(Schema.Boolean),
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      replyFromEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      noReplies: Schema.optionalKey(Schema.Boolean),
      /** The reply a new version's guidance is written for (a slot of this chat), or null for new turns. */
      guidanceSlotId: Schema.optionalKey(Schema.NullOr(SlotId)),
      /** Consume a one-reply pick only if it still names this card. */
      consumeReplyFromEntityId: Schema.optionalKey(EntityId)
    },
    success: ComposerChoice,
    error: Schema.Union([...Errors])
  })
) {}

/**
 * A workshop composer's attached cards, lorebooks and presets (spec/WORKSHOP-CARDS.md §4.4), in a
 * group of its own: AppCoreApi is at TypeScript's instantiation depth.
 */
export class ComposerLibraryApi extends RpcGroup.make(
  /** Its items, in the order attached. */
  Rpc.make("GetComposerLibrary", {
    payload: ComposerImageKey,
    success: Schema.Array(ComposerLibraryItem),
    error: Schema.Union([...Errors])
  }),
  /**
   * Removes, then attaches (a story's composer refuses: NotFound), and gives the list after. At
   * most 16, as a message carries.
   */
  Rpc.make("SetComposerLibrary", {
    payload: SetComposerLibraryFields,
    success: Schema.Array(ComposerLibraryItem),
    error: Schema.Union([...Errors])
  })
) {}
