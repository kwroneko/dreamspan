// Snippets and shared named notes are the same library entities (DESIGN §4.1). A snippet is for
// "All chats" or for one chat, every branch of it; its text edits as every library field does
// (the editor's drafts, edit history and revisions), so these are only the list, creating one
// and its scope.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId } from "./chat.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { LibraryRef, RefId } from "./library.ts"
import { EditRefused } from "./editorApi.ts"

export class Snippet extends Schema.Class<Snippet>("Snippet")({
  ref: LibraryRef,
  /** The live name and text: what's typed, saved as a revision or not. */
  title: Schema.String,
  content: Schema.String,
  /** For all chats; otherwise for the chat it was made in, every branch of it. */
  global: Schema.Boolean
}) {}
/** The chat shown (null outside a chat): its snippets are listed with the ones for all chats. */
export const SnippetContext = { chatId: Schema.NullOr(ChatId) }
export const CreateSnippetFields = { ...SnippetContext, title: Schema.String, content: Schema.String }
/** For all chats (`global`), or only the chat shown. */
export const SnippetScopeFields = { ...SnippetContext, refId: RefId, global: Schema.Boolean }
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
  /**
   * Moves a snippet between "This chat" and "All chats". Narrowing one that a card's note or
   * another chat's note shows is refused: they'd lose it.
   */
  Rpc.make("SetSnippetScope", {
    payload: SnippetScopeFields,
    success: Snippet,
    error: Schema.Union([NotFound, StaleWrite, ServerError, EditRefused])
  })
) {}
