// Draft history as rows instead of a blob (DESIGN §6.2): one reversible patch per entry,
// appended or extended in place, so a save never rewrites the whole history. History
// only lives while a draft is being written: a commit deletes it (owner, 2026-10-10).

export const draftHistory = [
  `ALTER TABLE drafts DROP COLUMN undo_log`,
  `ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'committed', 'discarded'))`,
  `ALTER TABLE drafts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX drafts_active ON drafts(user_id, updated_at DESC) WHERE status = 'active'`,

  // Entry `seq` turns the state before it into the state after it: at `start`,
  // `removed` was replaced by `inserted`. Applying entries' inverses from the newest
  // back walks the draft to any earlier state.
  `CREATE TABLE draft_history (
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('edit', 'restore')),
    first_at INTEGER NOT NULL,
    at INTEGER NOT NULL,
    start INTEGER NOT NULL CHECK (start >= 0),
    removed TEXT NOT NULL,
    inserted TEXT NOT NULL,
    PRIMARY KEY (draft_id, seq)
  ) STRICT, WITHOUT ROWID`,

  // A draft goes when its target is deleted. Draft targets aren't foreign keys, since one
  // column points into several tables.
  `CREATE TRIGGER drafts_gc_chat AFTER DELETE ON chats
    BEGIN DELETE FROM drafts WHERE target_kind = 'composer' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_version AFTER DELETE ON versions
    BEGIN DELETE FROM drafts WHERE target_kind = 'version_edit' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_slot AFTER DELETE ON slots
    BEGIN
      DELETE FROM drafts WHERE target_kind = 'scratchpad' AND target_id = OLD.id;
      DELETE FROM drafts WHERE target_kind = 'composer' AND target_id = OLD.chat_id AND field = OLD.id;
    END`,
  `CREATE TRIGGER drafts_gc_summary AFTER DELETE ON summaries
    BEGIN DELETE FROM drafts WHERE target_kind = 'summary_edit' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_ref AFTER DELETE ON entity_refs
    BEGIN DELETE FROM drafts WHERE target_kind = 'entity_field' AND target_id = OLD.id; END`
]

// Migration 0013: what a save needs to decide a conflict on its own (ARCHITECTURE §3.10).
// - `session` counts drafting sessions, up each time one ends (committed or discarded): text
//   typed in a session that has ended is never taken as the start of the next.
// - `text_version` is the row version the text last changed at. Moving a composer with its
//   tip changes the row version, not the text, so only a save since is another tab's.
// - `displaced` marks a history entry saved over another tab's text: the text before it goes
//   to the recovered texts when the session ends or the entry is dropped, whatever its size.
export const draftSessions = [
  `ALTER TABLE drafts ADD COLUMN session INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE drafts ADD COLUMN text_version INTEGER NOT NULL DEFAULT 1`,
  `UPDATE drafts SET text_version = row_version`,
  `ALTER TABLE draft_history ADD COLUMN displaced INTEGER NOT NULL DEFAULT 0 CHECK (displaced IN (0, 1))`
]
