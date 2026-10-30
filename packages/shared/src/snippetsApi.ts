// Snippets and shared named notes are the same library entities. These operations edit
// their continuously saved text; chat text uses the fork's revision binding.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ForkId } from "./chat.ts"
import { Draft, DraftHistoryPolicy, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { LibraryRef, RefId, RevisionId } from "./library.ts"
import { EditRefused } from "./editorApi.ts"

export const SnippetContext = { chatId: Schema.NullOr(ChatId), forkId: Schema.NullOr(ForkId) }
export class Snippet extends Schema.Class<Snippet>("Snippet")({
  ref: LibraryRef,
  title: Schema.String,
  content: Schema.String,
  global: Schema.Boolean,
  revision: RevisionId,
  draft: Schema.NullOr(Draft)
}) {}
export const CreateSnippetFields = { ...SnippetContext, title: Schema.String, content: Schema.String }
export const SaveSnippetFields = {
  ...CreateSnippetFields,
  refId: RefId,
  expectedRevision: RevisionId
}
export const GlobalSnippetFields = { ...SnippetContext, refId: RefId, expectedRevision: RevisionId }
export const SnippetHistoryFields = {
  ...SnippetContext,
  refId: RefId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DraftHistoryPolicy.maxEntries + 1 }))
}
/** Restores state `seq` of the snippet's text history and saves it as the snippet's text. */
export const RestoreSnippetFields = { ...GlobalSnippetFields, seq: Schema.Int }
export class SnippetsApi extends RpcGroup.make(
  Rpc.make("ListSnippets", {
    payload: { ...SnippetContext, query: Schema.optionalKey(Schema.String) },
    success: Schema.Array(Snippet),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("CreateSnippet", {
    payload: CreateSnippetFields,
    success: Snippet,
    error: Schema.Union([NotFound, ServerError, EditRefused])
  }),
  Rpc.make("SaveSnippet", {
    payload: SaveSnippetFields,
    success: Snippet,
    error: Schema.Union([NotFound, StaleWrite, ServerError, EditRefused])
  }),
  Rpc.make("MakeSnippetGlobal", {
    payload: GlobalSnippetFields,
    success: Snippet,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** The snippet's texts, newest first. A current library revision not yet in its draft has seq -1; only earlier states are restore targets. */
  Rpc.make("SnippetHistory", {
    payload: SnippetHistoryFields,
    success: Schema.Array(DraftState),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("RestoreSnippet", {
    payload: RestoreSnippetFields,
    success: Snippet,
    error: Schema.Union([NotFound, StaleWrite, ServerError, EditRefused])
  })
) {}
