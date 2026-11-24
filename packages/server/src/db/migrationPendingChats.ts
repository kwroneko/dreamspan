// 0014_pending_chats (draftchats1; DESIGN §2.1, owner 2026-11-23): the new-chat page is a real
// chat, status 'pending', reachable only by its URL until its first turn commits it. `draft_for`
// is the entry it was opened for (`card:<entity>`, `group:<chat>`, `empty`), so a reload reopens
// it there; NULL on every committed chat (commit clears it). No row is pending before this, so
// nothing is rewritten; the status value list already holds 'pending'.
export const pendingChatsMigration: ReadonlyArray<string> = [
  `ALTER TABLE chats ADD COLUMN draft_for TEXT`,
  `CREATE INDEX chats_pending ON chats(owner_user_id, draft_for, created_at) WHERE status = 'pending'`
]
