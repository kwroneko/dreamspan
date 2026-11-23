// Text search across many things at once (TextSearchApi): message text in all of the user's
// chats (db/messageSearch.ts), and search and replace across the library, which the reader plans
// and the writer stores (db/libraryReplace.ts, db/libraryReplaceWrites.ts).
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { LIBRARY_EDITS_LISTED, libraryEditTitle } from "@dreamspan/shared/libraryReplace.ts"
import { MESSAGE_PAGE } from "@dreamspan/shared/messageSearch.ts"
import type { TextSearchApi } from "@dreamspan/shared/textSearchApi.ts"
import type { ChatBrowse } from "@dreamspan/shared/chatBrowse.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Option } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { searchedChats, snapshotState } from "../db/shellViews.ts"
import { PARTIAL_AFTER } from "./chatSetup.ts"
import { internal } from "./internal.ts"

type ChatFilter = ChatBrowse["filter"]

export const makeTextSearchHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  // The shell's snapshot (shared, kept per epoch), decoded once each: what the Chats tab lists.
  const decoded = new WeakMap<object, ReturnType<typeof snapshotState>>()
  const shellState = (id: UserId) =>
    reader.ShellMaterialize({ userId: id }).pipe(
      Effect.timeoutOption(PARTIAL_AFTER),
      Effect.flatMap(
        Option.match({
          onSome: (snapshot) => Effect.succeed(snapshot),
          onNone: () => reader.ShellMaterializePartial({ userId: id })
        })
      ),
      Effect.map((snapshot) => {
        const known = decoded.get(snapshot)
        if (known) return known.state
        const state = snapshotState(snapshot)
        decoded.set(snapshot, state)
        return state.state
      })
    )
  /**
   * The chats a search looks through, by name: null for all of them, unless the Chat sort needs
   * their order. The filter and scope go to the reader's query, never to the hits afterwards.
   */
  const chatsOf = (
    id: UserId,
    filter: ChatFilter | undefined,
    entity: EntityId | null | undefined,
    ordered: boolean
  ) =>
    (filter ?? "all") === "all" && (entity ?? null) === null && !ordered
      ? Effect.succeed(null)
      : Effect.map(shellState(id), (state) => searchedChats(state, filter ?? "all", entity ?? null))
  return {
    SearchMessages: ({ text, cursor, sort, reversed, filter, entity }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const listed = yield* chatsOf(id, filter, entity, sort === "chat")
        // Z to A: the Chat sort's list the other way round.
        const chats = sort === "chat" && reversed === true && listed !== null ? [...listed].reverse() : listed
        return yield* reader.SearchMessages({
          userId: id,
          text,
          cursor,
          limit: MESSAGE_PAGE,
          sort: sort ?? "best",
          chats
        })
      }).pipe(internal("SearchMessages")),
    CountMessages: ({ text, filter, entity }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const chats = yield* chatsOf(id, filter, entity, false)
        return yield* reader.CountMessages({ userId: id, text, chats })
      }).pipe(internal("CountMessages")),
    PreviewLibraryReplace: ({ search }) =>
      Effect.flatMap(userId, (id) => reader.PreviewLibraryReplace({ userId: id, search })).pipe(
        internal("PreviewLibraryReplace")
      ),
    ApplyLibraryReplace: ({ search, choices }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const plan = yield* reader.PlanLibraryReplace({ userId: id, search, choices })
        const result = yield* writer.ApplyLibraryReplace({
          userId: id,
          title: libraryEditTitle(search),
          entries: plan.entries,
          skipped: plan.skipped
        })
        // What chats send may have changed: their cache estimates are worked out again.
        if (result.entries > 0) yield* warmth.refreshUser(id)
        return result
      }).pipe(internal("ApplyLibraryReplace")),
    ListLibraryEdits: () =>
      Effect.flatMap(userId, (id) => reader.ListLibraryEdits({ userId: id, limit: LIBRARY_EDITS_LISTED })).pipe(
        internal("ListLibraryEdits")
      ),
    UndoLibraryEdit: ({ editId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const result = yield* writer.UndoLibraryEdit({ userId: id, editId })
        if (result.undone > 0) yield* warmth.refreshUser(id)
        return result
      }).pipe(internal("UndoLibraryEdit"))
  } satisfies Parameters<typeof TextSearchApi.of>[0]
})
