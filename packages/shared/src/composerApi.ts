// The composer's text on the server (DESIGN §6.2, DATA-MODEL §10), merged into AppApi. Each
// branch tip of a chat has its own composer, a draft with server-side undo history: saved
// while the user types, read back on a reload or another device, committed with the send.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId } from "./chat.ts"
import { Draft, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"

/** Text past the drafts' cap (DraftHistoryPolicy.maxContentChars); nothing was saved. */
export class TextTooLong extends Schema.TaggedError<TextTooLong>()("TextTooLong", {
  length: Schema.Int,
  max: Schema.Int
}) {}

/** Which composer: a chat's, at the slot the next message goes under (null before the first). */
const Composer = { chatId: ChatId, tipSlotId: Schema.NullOr(SlotId) }

const Errors = [NotFound, ServerError] as const
const Writes = [NotFound, StaleWrite, ServerError] as const

/**
 * A SaveComposer, also as a closing page sends it with the editors' drafts (`composers` in
 * `POST /library/drafts`, with keepalive).
 */
export const ComposerBeacon = Schema.Struct({
  ...Composer,
  content: Schema.String,
  expectedRowVersion: Schema.NullOr(Schema.Int)
})

export class ComposerApi extends RpcGroup.make(
  /** The composer's draft, or null if nothing was ever typed there. */
  Rpc.make("GetComposer", { payload: Composer, success: Schema.NullOr(Draft), error: Schema.Union([...Errors]) }),
  /**
   * Saves what's typed (debounced by the client). `expectedRowVersion` is the draft as last
   * read, null before there is one: another tab's newer text is a StaleWrite, never
   * overwritten unseen. Every change is kept in the draft's history.
   */
  Rpc.make("SaveComposer", {
    payload: ComposerBeacon.fields,
    success: Draft,
    error: Schema.Union([...Writes, TextTooLong])
  }),
  /** The restorable states of the composer's text, newest first. */
  Rpc.make("ComposerHistory", {
    payload: { ...Composer, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })) },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  /** Moves the text back to an earlier state; the restore can be undone too. */
  Rpc.make("RestoreComposer", {
    payload: { ...Composer, seq: Schema.Int, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([...Writes])
  })
) {}
