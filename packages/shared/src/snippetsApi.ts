// Snippets and shared named notes are the same library entities. These operations edit
// their continuously saved text; chat text uses the fork's revision binding.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ForkId } from "./chat.ts"
import { Draft } from "./drafts.ts"
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
  })
) {}
