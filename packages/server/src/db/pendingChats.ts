// A pending chat's life (DESIGN §2.1, owner 2026-11-23): the new-chat page opens a real chat,
// status 'pending', that every account-wide reader leaves out (listedChats.ts). Its first turn
// commits it, in the write that makes that turn, and a pending chat nobody keeps is swept, its
// typing filed to recovered texts. Only this module changes a chat's status or deletes a pending
// chat (test/chatReaders.test.ts).
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { chatCast, chatStateAt } from "./cards.ts"

/**
 * A chat's default title: its characters, never just the first character's name (DESIGN §2.1).
 * The persona the user plays is left out, as the client's automatic name leaves it out
 * (`chatTitle.ts` `castCharacters`), so a 1:1 reads "Mira, Oct 31" much as an imported one does.
 */
export const titleFor = (names: ReadonlyArray<string>, at: number) =>
  names.length > 1
    ? names.join(" & ")
    : `${names[0] ?? "Chat"}, ${new Date(at).toLocaleDateString("en", { day: "numeric", month: "short" })}`

interface PendingRow {
  readonly id: ChatId
  readonly owner_user_id: UserId
  readonly title_source: string
  readonly draft_for: string | null
  readonly active_leaf_slot_id: string | null
}

/**
 * The characters a pending chat has now, by name, in cast order: who you play left out. Each
 * by the revision the chat uses (a pinned one's name, not the library's), as its list row has it.
 */
const castNames = (sql: SqlClient.SqlClient, chat: PendingRow) =>
  Effect.gen(function* () {
    const playing = new Set<string>((yield* chatStateAt(sql, chat.id, chat.active_leaf_slot_id)).playedByMe)
    const cast = yield* chatCast(sql, chat.owner_user_id, chat.id, chat.active_leaf_slot_id)
    return cast.filter((card) => !playing.has(card.entityId)).map((card) => card.name)
  })

const pendingRow = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.map(
    sql<PendingRow>`SELECT id, owner_user_id, title_source, draft_for, active_leaf_slot_id FROM chats /* chat:includes-pending: this chat's lifecycle */
      WHERE id = ${chatId} AND status = 'pending'`,
    ([row]) => row ?? null
  )

/**
 * Commits a pending chat, in the write that makes its first turn (a message, a reply, a Continue
 * or swipe of a greeting, a saved greeting edit): it becomes active and starts now, as if made
 * now (`created_at`, `last_message_at`, each fork's making and last chat), its automatic title
 * taken from the cast it has now (a group's new chat keeps the group's name). Greetings keep
 * their own times. Nothing for a chat that isn't pending. True when it committed.
 */
export const commitPendingChat = (sql: SqlClient.SqlClient, chatId: string, at: number) =>
  Effect.gen(function* () {
    const chat = yield* pendingRow(sql, chatId)
    if (chat === null) return false
    const retitle = chat.title_source === "auto" && !(chat.draft_for ?? "").startsWith("group:")
    const title = retitle ? titleFor(yield* castNames(sql, chat), at) : null
    yield* sql`UPDATE chats SET status = 'active', draft_for = NULL, created_at = ${at}, last_message_at = ${at},
        title = coalesce(${title}, title), row_version = row_version + 1
      WHERE id = ${chatId} AND status = 'pending'`
    yield* sql`UPDATE forks SET created_at = ${at}, last_chatted_at = ${at}, row_version = row_version + 1
      WHERE chat_id = ${chatId}`
    return true
  })

/** `commitPendingChat` for the chat a message is in. */
export const commitPendingChatOf = (sql: SqlClient.SqlClient, slotId: string, at: number) =>
  Effect.flatMap(
    sql<{
      chat_id: string
    }>`SELECT s.chat_id FROM slots s JOIN chats c ON c.id = s.chat_id /* chat:includes-pending: commits it */
      WHERE s.id = ${slotId} AND c.status = 'pending'`,
    ([row]) => (row === undefined ? Effect.succeed(false) : commitPendingChat(sql, row.chat_id, at))
  )

interface SweptDraft {
  readonly id: string
  readonly target_kind: DraftKey["targetKind"]
  readonly target_id: string
  readonly field: string
  readonly content: string
}

/**
 * Removes a pending chat of the user's that nobody keeps (left, or abandoned: the caller decides),
 * in the caller's transaction. Its typing goes to recovered texts first, as "New chat with
 * <names>": the composer, a greeting edit not saved, anything else typed into it, each with what
 * its history protects (the text before a destructive change or another tab's, as a discard
 * keeps it), even when the draft is empty now. The chat is deleted with everything in it (its
 * greetings, state and drafts go with it by cascade). An untouched one files nothing. Nothing
 * for a chat that isn't pending. True when it was swept.
 */
export const sweepPendingChat = (sql: SqlClient.SqlClient, bin: Bin, userId: UserId, chatId: string) =>
  Effect.gen(function* () {
    const chat = yield* pendingRow(sql, chatId)
    if (chat === null || chat.owner_user_id !== userId) return false
    const typed = yield* sql<SweptDraft>`
      SELECT d.id, d.target_kind, d.target_id, d.field, d.content FROM drafts d
      WHERE d.user_id = ${userId} AND d.status = 'active' AND (
        (d.target_kind IN ('composer', 'insert', 'queue_edit') AND d.target_id = ${chatId})
        OR (d.target_kind = 'version_edit' AND d.target_id IN (
          SELECT v.id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ${chatId}))
        OR (d.target_kind = 'scratchpad' AND d.target_id IN (SELECT id FROM slots WHERE chat_id = ${chatId})))
      ORDER BY d.updated_at`
    let source: string | null = null
    for (const draft of typed) {
      // A greeting edit still holds the greeting itself, and the card holds it: only edits are filed.
      const [version] =
        draft.target_kind === "version_edit"
          ? yield* sql<{ content: string }>`SELECT content FROM version_records WHERE id = ${draft.target_id}`
          : []
      const lost = yield* bin.drafts.unsaved(draft.id, draft.content, version === undefined ? [] : [version.content])
      if (lost.length === 0) continue
      if (source === null) {
        const names = yield* castNames(sql, chat)
        source = names.length === 0 ? "New chat" : `New chat with ${names.join(" & ")}`
      }
      yield* bin.recover(
        userId,
        new DraftKey({ targetKind: draft.target_kind, targetId: draft.target_id, field: draft.field }),
        lost,
        "discard",
        source
      )
    }
    yield* sql`DELETE FROM chats WHERE id = ${chatId} AND status = 'pending' /* chat:includes-pending: sweeps it */`
    return true
  })
