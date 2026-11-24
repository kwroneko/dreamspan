// 0014_pending_chats (draftchats1; DESIGN §2.1, owner 2026-11-23): the new-chat page is a real
// chat, status 'pending', reachable only by its URL until its first turn commits it. `draft_for`
// is the entry it was opened for (`card:<entity>`, `group:<chat>`, `empty`), so a reload reopens
// it there; NULL on every committed chat (commit clears it). No row is pending before this, so
// nothing is rewritten; the status value list already holds 'pending'.
//
// A swept pending chat leaves a row in `swept_pending_chats` (db/pendingChats.ts), so a save a
// tab sends it later (typed offline, a keepalive) still reaches recovered texts, under the same
// name; `swept_pending_saves` makes a retried save file once.
//
// The first message typed on the old new-chat pages had a draft of its own, keyed by the entry
// (`pending-chat:<card>`, `pending-group-chat:<members>:<name>`; a card source's `pending-chat:src:`
// page keeps its own): nothing reads those any more, so their text goes to recovered texts.
export const legacyPendingDraft = (targetId: string, field: string) =>
  field === "First message" &&
  (targetId.startsWith("pending-group-chat:") ||
    (targetId.startsWith("pending-chat:") && !targetId.startsWith("pending-chat:src:")))

const legacy = `target_kind = 'user_field' AND field = 'First message'
  AND (target_id LIKE 'pending-group-chat:%' OR (target_id LIKE 'pending-chat:%' AND target_id NOT LIKE 'pending-chat:src:%'))`

export const pendingChatsMigration: ReadonlyArray<string> = [
  `ALTER TABLE chats ADD COLUMN draft_for TEXT`,
  `CREATE INDEX chats_pending ON chats(owner_user_id, draft_for, created_at) WHERE status = 'pending'`,
  `CREATE TABLE swept_pending_chats (
    chat_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    swept_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX swept_pending_chats_at ON swept_pending_chats(swept_at)`,
  `CREATE TABLE swept_pending_saves (
    chat_id TEXT NOT NULL REFERENCES swept_pending_chats(chat_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, operation_id)
  ) STRICT`,
  `CREATE TRIGGER swept_pending_chats_owner_fixed BEFORE UPDATE OF user_id ON swept_pending_chats
      WHEN NEW.user_id IS NOT OLD.user_id
      BEGIN SELECT RAISE(ABORT, 'swept_pending_chats never change owner'); END`,
  `INSERT INTO recovered_texts (id, user_id, source_kind, source_id, source_field, source_label, reason, content, byte_size, created_at)
    SELECT lower(hex(randomblob(16))), user_id, 'user_field', target_id, field,
      CASE WHEN target_id LIKE 'pending-group-chat:%' THEN 'New chat'
        ELSE coalesce('New chat with ' || (SELECT r.label FROM entity_refs r WHERE r.entity_id = substr(drafts.target_id, 14)), 'New chat') END,
      'discard', content, length(CAST(content AS BLOB)), updated_at
    FROM drafts WHERE ${legacy} AND trim(content) <> ''`,
  `DELETE FROM drafts WHERE ${legacy}`
]
