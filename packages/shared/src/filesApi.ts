// The RPCs of the file manager (spec/FILES-AND-ENVIRONMENT.md §8.2): the editor's unsaved edits,
// kept as drafts (`file`, by path) so they survive reloads and other devices until saved. The
// file's bytes move over the HTTP routes (`files.ts` FILES_ROUTES); a save names the hash the
// text was typed on.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { TextTooLong } from "./composerApi.ts"
import { Draft, ObservedDeletion } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { TEXT_EDIT_MAX_CHARS } from "./files.ts"

const FilePath = Schema.String.check(Schema.isMaxLength(4096))

/** A save of an editor's text, as typed: the draft it was typed into and the file it was typed on. */
export const FileDraftSave = Schema.Struct({
  path: FilePath,
  observedDeletion: Schema.optionalKey(ObservedDeletion),
  draftId: Schema.NullOr(Schema.String),
  content: Schema.String.check(Schema.isMaxLength(TEXT_EDIT_MAX_CHARS)),
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.NullOr(Schema.Int),
  /** SHA-256 of the file's bytes the text was typed on (`TextFile.sha256`). */
  baseSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
})
export type FileDraftSave = typeof FileDraftSave.Type

export class FilesApi extends RpcGroup.make(
  /** The unsaved edit of a file of the user's Files, if there is one. */
  Rpc.make("GetFileDraft", {
    payload: { path: FilePath },
    success: Schema.NullOr(Draft),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SaveFileDraft", {
    payload: FileDraftSave.fields,
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, TextTooLong, ServerError])
  }),
  /**
   * Ends the edit: `committed` once the text is saved to the file, `discarded` when the user threw
   * it away (its text one step back in the recovered texts).
   */
  Rpc.make("EndFileDraft", {
    payload: {
      path: FilePath,
      draftId: Schema.String,
      expectedRowVersion: Schema.Int,
      outcome: Schema.Literals(["committed", "discarded"])
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
