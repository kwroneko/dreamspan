// Snippets (DESIGN §4.1): shared notes kept beside chats. One is for "All chats" (`owner.shared`
// "global") or for one chat, every branch of it ("This chat", owner 2026-11-01: not inherited by
// forks); its text is the library head and the live text of its drafts, as every library field's.
import type { UserId } from "@rp/shared/domain.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { textField } from "@rp/shared/editing.ts"
import { Snippet } from "@rp/shared/snippetsApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef, type RefRow } from "./library.ts"
import { NotFound } from "./ops.ts"

/** The user's live chat, and its fork shown (the current one when none is named). */
export const chatFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId | null,
  forkId: ForkId | null
) {
  if (chatId === null) return null
  const [row] = yield* sql<{ id: string }>`SELECT f.id FROM chats c JOIN forks f
    ON f.id = coalesce(${forkId}, c.current_fork_id) AND f.chat_id = c.id
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
  if (!row) return yield* new NotFound({ entity: "chat", id: chatId })
  return row.id
})

/**
 * A snippet as the list shows it, with its live text (what's typed since its last revision), or
 * null when it isn't one here: not a shared note, or another chat's.
 */
export const readSnippet = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  ref: RefRow,
  chatId: string | null
) {
  const lib = makeLibraryQueries(sql)
  const head = yield* lib.loadDoc(ref.head_revision_id)
  const scope = (head.owner as { shared?: string } | undefined)?.shared
  if (ref.kind !== "note" || scope === undefined || (scope !== "global" && scope !== chatId)) return null
  const drafts = makeDraftStore(sql)
  const live = (path: string, saved: unknown) =>
    Effect.map(
      drafts.find(userId, new DraftKey({ targetKind: "entity_field", targetId: ref.id, field: textField([path]) })),
      (draft) => (draft !== null && draft.status === "active" ? draft.content : String(saved ?? ""))
    )
  return new Snippet({
    ref: toLibraryRef(ref),
    title: yield* live("title", head.title),
    content: yield* live("content", head.content),
    global: scope === "global"
  })
})
