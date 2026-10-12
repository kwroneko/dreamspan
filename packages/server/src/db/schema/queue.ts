// Migration 0012: the send queue (DESIGN §2.2). A message sent, or a reply asked for,
// while the reply it follows is still being written waits here, held by the server, until
// that reply ends; then it posts as a normal send would (ARCHITECTURE §12).
//
// It reaches its owner through its chat, like every row in a chat: no owner column.
import { raise } from "./integrity.ts"

export const queue = [
  `CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- The reply it waits for: the slot, not a version, so it posts after whichever version
    -- ends up selected.
    reply_slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    -- Order among the entries waiting in a chat.
    seq INTEGER NOT NULL,
    -- A message to post, or a reply to generate.
    kind TEXT NOT NULL CHECK (kind IN ('message', 'generate')),
    content TEXT NOT NULL,
    speaker_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    -- For 'message': who replies to it once it posts, picked when it was sent, as an
    -- immediate send's reply is.
    reply_speaker_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    -- For 'generate': the one-turn direction the reply gets.
    direction TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (kind = 'generate' OR length(content) > 0),
    CHECK (kind = 'generate' OR direction IS NULL),
    CHECK (kind = 'message' OR reply_speaker_entity_id IS NULL)
  ) STRICT`,
  `CREATE INDEX queued_messages_reply ON queued_messages(reply_slot_id, seq)`,
  `CREATE INDEX queued_messages_chat ON queued_messages(chat_id, seq)`,
  `CREATE INDEX queued_messages_speaker ON queued_messages(speaker_entity_id)`,
  `CREATE INDEX queued_messages_reply_speaker ON queued_messages(reply_speaker_entity_id)`,

  // It stays in its chat, waits for a slot of that chat, and speaks as a card of the
  // chat's owner: one statement can't point it at another user's chat or card.
  `CREATE TRIGGER queued_messages_chat_fixed BEFORE UPDATE OF chat_id ON queued_messages
    WHEN NEW.chat_id IS NOT OLD.chat_id
    BEGIN ${raise("queued messages never move to another chat")}; END`,
  `CREATE TRIGGER queued_messages_reply_same_chat BEFORE INSERT ON queued_messages
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.reply_slot_id) IS NOT NEW.chat_id
    BEGIN ${raise("queued_messages.reply_slot_id must be in the same chat")}; END`,
  `CREATE TRIGGER queued_messages_reply_same_chat_update BEFORE UPDATE OF reply_slot_id ON queued_messages
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.reply_slot_id) IS NOT NEW.chat_id
    BEGIN ${raise("queued_messages.reply_slot_id must be in the same chat")}; END`,
  `CREATE TRIGGER queued_messages_speaker_owner BEFORE INSERT ON queued_messages
    WHEN NEW.speaker_entity_id IS NOT NULL AND (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN ${raise("a queued message speaks as a card of the chat's owner")}; END`,
  `CREATE TRIGGER queued_messages_speaker_owner_update BEFORE UPDATE OF speaker_entity_id ON queued_messages
    WHEN NEW.speaker_entity_id IS NOT NULL AND (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN ${raise("a queued message speaks as a card of the chat's owner")}; END`,
  `CREATE TRIGGER queued_messages_reply_speaker_owner BEFORE INSERT ON queued_messages
    WHEN NEW.reply_speaker_entity_id IS NOT NULL
      AND (SELECT owner_user_id FROM entities WHERE id = NEW.reply_speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN ${raise("a queued message's reply speaks as a card of the chat's owner")}; END`,
  `CREATE TRIGGER queued_messages_reply_speaker_owner_update BEFORE UPDATE OF reply_speaker_entity_id ON queued_messages
    WHEN NEW.reply_speaker_entity_id IS NOT NULL
      AND (SELECT owner_user_id FROM entities WHERE id = NEW.reply_speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN ${raise("a queued message's reply speaks as a card of the chat's owner")}; END`
]
