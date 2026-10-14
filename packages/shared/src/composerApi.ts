// The composer's text on the server (DESIGN §6.2, DATA-MODEL §10), merged into AppApi. Each
// branch tip of a chat has its own composer, a draft with server-side undo history: saved
// while the user types, read back on a reload or another device, committed with the send.
//
// A composer's draft moves with its tip when a message is appended there, so the client
// names the draft its text was typed into (its id, row version and session), never just
// the tip: the server saves the text onto that draft wherever it is now (ARCHITECTURE §3.10).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, SlotId } from "./chat.ts"
import { Draft, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"

/** Text past the drafts' cap (DraftHistoryPolicy.maxContentChars); nothing was saved. */
export class TextTooLong extends Schema.TaggedError<TextTooLong>()("TextTooLong", {
  length: Schema.Int,
  max: Schema.Int
}) {}

const Errors = [NotFound, ServerError] as const

/**
 * Who a composer speaks as, and who replies to its next send (DESIGN §2.2), kept with its
 * draft on the server: they move with the draft to the next tip, so a reload, another tab
 * or another device finds the same speaker, never a reset to the first card (ST-GRIPES D8).
 */
export class ComposerChoice extends Schema.Class<ComposerChoice>("ComposerChoice")({
  draftId: Schema.String,
  /** The card picked to speak as; null until one is, when the composer picks its default. */
  speakerEntityId: Schema.NullOr(EntityId),
  /** Who replies to the next send, picked for that one reply; null: the next in turn. */
  replyFromEntityId: Schema.NullOr(EntityId)
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

export class ComposerApi extends RpcGroup.make(
  /**
   * The composer at a tip of the chat (null: before the first message), made empty if
   * there's none. `copyFrom` (a composer draft's id) starts a branch: its text is copied
   * in, unless this tip has text of its own (DESIGN §6.2).
   */
  Rpc.make("OpenComposer", {
    payload: { chatId: ChatId, tipSlotId: Schema.NullOr(SlotId), copyFrom: Schema.optionalKey(Schema.String) },
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
    success: Schema.Struct({ draft: Schema.NullOr(Draft), recovered: Schema.Boolean }),
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
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      replyFromEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      /** Consume a one-reply pick only if it still names this card. */
      consumeReplyFromEntityId: Schema.optionalKey(EntityId)
    },
    success: ComposerChoice,
    error: Schema.Union([...Errors])
  })
) {}
