// A pending chat's life (DESIGN §2.1, owner 2026-11-23): the new-chat page opens a real chat,
// status 'pending', that every account-wide reader leaves out (listedChats.ts). Its first turn
// commits it, in the write that makes that turn, and a pending chat nobody keeps is swept, its
// typing filed to recovered texts. Only this module changes a chat's status or deletes a pending
// chat (test/chatReaders.test.ts).
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { chatCast, chatStateAt } from "./cards.ts"
import { personaInStory } from "./workshopDefaults.ts"

/**
 * A chat's default title: its characters, never just the first character's name (DESIGN §2.1).
 * The persona the user plays is left out, as the client's automatic name leaves it out
 * (`chatTitle.ts` `castCharacters`), so a 1:1 reads "Mira, Oct 31" much as an imported one does.
 */
export const titleFor = (names: ReadonlyArray<string>, at: number) =>
  names.length > 1
    ? names.join(" & ")
    : `${names[0] ?? "Chat"}, ${new Date(at).toLocaleDateString("en", { day: "numeric", month: "short" })}`

/** How long a swept pending chat's late saves are still filed. */
const SWEPT_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A reply that finished empty and was removed (chatSetupWrites.ts FinishGeneration
 * `discardEmpty`): its slot and version, so a save of a swipe or an edit of it that comes after
 * (its first save, or a browser's retry) is filed to recovered texts rather than refused. The
 * receipt is a row of `swept_pending_chats` keyed `dropped-reply:<id>`, kept as long as a swept
 * chat's, so no schema change: ids are never chat ids, and only `droppedReplyLabel` reads these.
 */
const DROPPED_REPLY = "dropped-reply:"
const DROPPED_REPLY_LABEL = "Empty reply"
export const noteDroppedReply = (sql: SqlClient.SqlClient, userId: UserId, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const now = Date.now()
    for (const id of ids)
      yield* sql`INSERT OR REPLACE INTO swept_pending_chats (chat_id, user_id, label, swept_at)
        VALUES (${DROPPED_REPLY + id}, ${userId}, ${DROPPED_REPLY_LABEL}, ${now})`
  })
/**
 * The library items a swept pending chat's composer still held: a receipt row of
 * `swept_pending_chats` keyed `swept-library:<chat id>`, their ref ids as JSON in `label`, kept
 * as long as the chat's own (no schema change, as `dropped-reply:` above). A chat opened in its
 * place carries on only these (writes.ts SetComposerLibrary `carriedFrom`, rev-dd5 #2).
 */
const SWEPT_LIBRARY = "swept-library:"
const noteSweptLibrary = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, now: number) =>
  Effect.gen(function* () {
    const held = yield* sql<{ ref_id: string }>`SELECT l.ref_id FROM composer_library l JOIN drafts d ON d.id = l.draft_id
      WHERE d.user_id = ${userId} AND d.target_kind = 'composer' AND d.target_id = ${chatId} ORDER BY l.position`
    yield* sql`INSERT OR REPLACE INTO swept_pending_chats (chat_id, user_id, label, swept_at)
      VALUES (${SWEPT_LIBRARY + chatId}, ${userId}, ${JSON.stringify(held.map((row) => row.ref_id))}, ${now})`
  })
/** What swept chat `chatId`'s composer held, none when there's no receipt of it (another user's, or expired). */
export const sweptComposerLibrary = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  sql<{ label: string }>`SELECT label FROM swept_pending_chats
    WHERE chat_id = ${SWEPT_LIBRARY + chatId} AND user_id = ${userId}
      AND swept_at >= ${Date.now() - SWEPT_KEPT_MS}`.pipe(
    Effect.map(([row]) => (row === undefined ? [] : (JSON.parse(row.label) as ReadonlyArray<string>)))
  )

/** The label a late save to the removed reply's `targetId` (a slot or a version) is filed under. */
export const droppedReplyLabel = (sql: SqlClient.SqlClient, userId: UserId, targetId: string) =>
  sql<{ label: string }>`SELECT label FROM swept_pending_chats
    WHERE chat_id = ${DROPPED_REPLY + targetId} AND user_id = ${userId}
      AND swept_at >= ${Date.now() - SWEPT_KEPT_MS}`.pipe(Effect.map(([row]) => row?.label ?? null))

export interface PendingRow {
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

export const pendingRow = (sql: SqlClient.SqlClient, chatId: string) =>
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
    // A workshop beside a story never starts as the story's persona or one of its cards, which
    // the story may have taken since the persona was picked (rev-dfu1 #6): refused, the
    // composer kept, so another persona can be picked and the message sent again.
    if ((chat.draft_for ?? "").startsWith("side:")) {
      const story = chat.draft_for!.split(":")[1]!
      const state = yield* chatStateAt(sql, chat.id, chat.active_leaf_slot_id)
      for (const persona of state.playedByMe)
        if (yield* personaInStory(sql, chat.owner_user_id, story, persona))
          return yield* new NotFound({ entity: "story-persona", id: persona })
    }
    // A group's new chat keeps the group's name, a workshop its own ("Workshop", or the one given).
    const retitle =
      chat.title_source === "auto" &&
      !(chat.draft_for ?? "").startsWith("group:") &&
      !(chat.draft_for ?? "").startsWith("workshop:") &&
      !(chat.draft_for ?? "").startsWith("side:")
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

/** A draft of a pending chat's whose typing is filed (`fileTyped`), at the target it was typed for. */
export interface SweptDraft {
  readonly id: string
  readonly target_kind: DraftKey["targetKind"]
  readonly target_id: string
  readonly field: string
  readonly content: string
  /** A greeting edit's greeting, which the card holds: only what differs from it is filed. */
  readonly greeting?: string
}

/**
 * Files what was typed into these drafts of a pending chat to recovered texts, as "New chat with
 * <names>", each with what its history protects (`bin.drafts.unsaved`). A greeting edit's own
 * greeting isn't filed. The drafts themselves are left to the caller.
 */
export const fileTyped = (
  sql: SqlClient.SqlClient,
  bin: Pick<Bin, "drafts" | "recover">,
  chat: PendingRow,
  typed: ReadonlyArray<SweptDraft>
) =>
  Effect.gen(function* () {
    let source: string | null = null
    for (const draft of typed) {
      const [version] =
        draft.greeting !== undefined
          ? [{ content: draft.greeting }]
          : draft.target_kind === "version_edit"
            ? yield* sql<{ content: string }>`SELECT content FROM version_records WHERE id = ${draft.target_id}`
            : []
      const lost = yield* bin.drafts.unsaved(draft.id, draft.content, version === undefined ? [] : [version.content])
      if (lost.length === 0) continue
      if (source === null) {
        const names = yield* castNames(sql, chat)
        source = names.length === 0 ? "New chat" : `New chat with ${names.join(" & ")}`
      }
      yield* bin.recover(
        chat.owner_user_id,
        new DraftKey({ targetKind: draft.target_kind, targetId: draft.target_id, field: draft.field }),
        lost,
        "discard",
        source
      )
    }
  })

/**
 * The first message typed on the old workshop pages, before a new workshop and a story's
 * Workshop tab became pending chats (draftchats5, sidedraft): a `user_field` draft under
 * `pending-workshop:new` or `pending-workshop:<story>`, which nothing reads any more.
 */
export const legacyWorkshopDraft = (targetId: string, field: string) =>
  field === "First message" && targetId.startsWith("pending-workshop:")

/** What such a draft's text is filed as: the story's name when it was typed beside one. */
export const legacyWorkshopLabel = (sql: SqlClient.SqlClient, userId: string, targetId: string) =>
  Effect.map(
    sql<{ title: string }>`SELECT title FROM chats /* chat:includes-pending: names a story by id */
      WHERE id = ${targetId.slice("pending-workshop:".length)} AND owner_user_id = ${userId}`,
    ([story]) => (story?.title?.trim() ? `Workshop about ${story.title.trim()}` : "New workshop")
  )

/**
 * Files every old workshop page's first message (`legacyWorkshopDraft`) to recovered texts,
 * with every text its history can restore, and deletes the draft (its history with it). Run as
 * the writer starts: idempotent, and nothing once they are gone. A save sent to such a key later
 * (a browser's copy) is filed the same way (writes.ts).
 */
export const fileLegacyWorkshopDrafts = (sql: SqlClient.SqlClient, bin: Pick<Bin, "drafts" | "recover">) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ id: string; user_id: UserId; target_id: string; field: string; content: string }>`
      SELECT id, user_id, target_id, field, content FROM drafts
      WHERE target_kind = 'user_field' AND field = 'First message' AND target_id LIKE 'pending-workshop:%'`
    for (const row of rows) {
      const lost = yield* bin.drafts.unsaved(row.id, row.content, [])
      if (lost.length > 0)
        yield* bin.recover(
          row.user_id,
          new DraftKey({ targetKind: "user_field", targetId: row.target_id, field: row.field }),
          lost,
          "discard",
          yield* legacyWorkshopLabel(sql, row.user_id, row.target_id),
          // Each text is there to see after the upgrade, however small the section's limit:
          // their drafts go now, so an eviction here would lose them (rev-dfu1 #2).
          { evict: false }
        )
      yield* sql`DELETE FROM drafts WHERE id = ${row.id}`
    }
    return rows.length
  })

/**
 * Removes a pending chat of the user's that nobody keeps (left, or abandoned: the caller decides),
 * in the caller's transaction. Its typing goes to recovered texts first, as "New chat with
 * <names>": the composer, a greeting edit not saved, anything else typed into it, each with what
 * its history protects (the text before a destructive change or another tab's, as a discard
 * keeps it), even when the draft is empty now. The chat is deleted with everything in it (its
 * greetings, state and drafts go with it by cascade). An untouched one files nothing. Nothing
 * for a chat that isn't pending. True when it was swept.
 */
export const sweepPendingChat = (
  sql: SqlClient.SqlClient,
  bin: Pick<Bin, "drafts" | "recover">,
  userId: UserId,
  chatId: string
) =>
  Effect.gen(function* () {
    const chat = yield* pendingRow(sql, chatId)
    if (chat === null || chat.owner_user_id !== userId) return false
    const typed = yield* sql<SweptDraft>`
      SELECT d.id, d.target_kind, d.target_id, d.field, d.content FROM drafts d
      WHERE d.user_id = ${userId} AND d.status IN ('active', 'discarded') AND (
        (d.target_kind IN ('composer', 'insert', 'queue_edit') AND d.target_id = ${chatId})
        OR (d.target_kind = 'version_edit' AND d.target_id IN (
          SELECT v.id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ${chatId}))
        OR (d.target_kind = 'scratchpad' AND d.target_id IN (SELECT id FROM slots WHERE chat_id = ${chatId})))
      ORDER BY d.updated_at`
    yield* fileTyped(sql, bin, chat, typed)
    // A save its tabs send later still reaches recovered texts under this name (writes.ts
    // SaveComposer); kept a week.
    const names = yield* castNames(sql, chat)
    const now = Date.now()
    yield* sql`DELETE FROM swept_pending_chats WHERE swept_at < ${now - SWEPT_KEPT_MS}`
    yield* sql`INSERT OR REPLACE INTO swept_pending_chats (chat_id, user_id, label, swept_at)
      VALUES (${chatId}, ${userId}, ${names.length === 0 ? "New chat" : `New chat with ${names.join(" & ")}`}, ${now})`
    yield* noteSweptLibrary(sql, userId, chatId, now)
    yield* sql`DELETE FROM chats WHERE id = ${chatId} AND status = 'pending' /* chat:includes-pending: sweeps it */`
    return true
  })
