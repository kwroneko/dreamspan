// Finding text across many things at once: message text in all of the user's chats (ARCHITECTURE
// §12 "Finding a message"), and search and replace through every library entry (§14.6 "Across
// the library"). The RPCs are their own group, merged into AppApi like the merge group.
import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import { NotFound, ServerError } from "./errors.ts"
import {
  LibraryChoice,
  LibraryEdit,
  LibraryPreview,
  LibraryReplaceRejected,
  LibraryReplaceResult,
  LibrarySearch,
  LibraryUndoResult
} from "./libraryReplace.ts"
import { EntityId } from "./chat.ts"
import { CHAT_FILTERS } from "./chatBrowse.ts"
import { MessageCount, MessageCursor, MessageQuery, MessageSearchPage, MessageSort } from "./messageSearch.ts"

/**
 * Which chats a message search looks through: those the Chats tab's filter shows (`filter`,
 * default all), of one character's chats when `entity` is given, as the left panel lists them.
 */
const SearchScope = {
  filter: Schema.optionalKey(Schema.Literals(CHAT_FILTERS)),
  entity: Schema.optionalKey(Schema.NullOr(EntityId))
}

export class TextSearchApi extends RpcGroup.make(
  /**
   * Messages in the user's chats (`filter`, `entity`) whose text has each of `text`'s words (as
   * the start of a word), in `sort`'s order (Best match by default; `reversed` turns the Chat
   * sort Z to A): each a message version with the branches that show it (messageSearch.ts).
   * `cursor` is the previous page's `next`.
   */
  Rpc.make("SearchMessages", {
    payload: {
      text: MessageQuery,
      cursor: Schema.NullOr(MessageCursor),
      sort: Schema.optionalKey(MessageSort),
      reversed: Schema.optionalKey(Schema.Boolean),
      ...SearchScope
    },
    success: MessageSearchPage,
    error: ServerError
  }),
  /** How many messages SearchMessages finds in those chats, and in how many chats; capped. */
  Rpc.make("CountMessages", {
    payload: { text: MessageQuery, ...SearchScope },
    success: MessageCount,
    error: ServerError
  }),
  /** Every entry of the chosen kinds with a match, by field, as its editor shows it now. */
  Rpc.make("PreviewLibraryReplace", {
    payload: { search: LibrarySearch },
    success: LibraryPreview,
    error: Schema.Union([LibraryReplaceRejected, ServerError])
  }),
  /**
   * Replaces in the fields chosen of the entries chosen, as one replace (`editId`) that writes
   * a revision of each; an entry changed since its preview is left as it is (`skipped`).
   */
  Rpc.make("ApplyLibraryReplace", {
    payload: {
      search: LibrarySearch,
      choices: Schema.Array(LibraryChoice).check(Schema.isMinLength(1), Schema.isMaxLength(5000))
    },
    success: LibraryReplaceResult,
    error: Schema.Union([LibraryReplaceRejected, ServerError])
  }),
  /** The latest replaces across the library, newest first. */
  Rpc.make("ListLibraryEdits", {
    success: Schema.Array(LibraryEdit),
    error: ServerError
  }),
  /** Takes a replace back in every entry nothing changed since; the others are `kept`. */
  Rpc.make("UndoLibraryEdit", {
    payload: { editId: Schema.String },
    success: LibraryUndoResult,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
