// Draft history as rows instead of a blob (DESIGN §6.2): one reversible patch per entry,
// appended or extended in place, so a save never rewrites the whole history. History
// only lives while a draft is being written: a commit deletes it (owner, 2026-10-10).

export const draftHistory = [
  `ALTER TABLE drafts DROP COLUMN undo_log`,
  `ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'committed', 'discarded'))`,
  `ALTER TABLE drafts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  // The text from before the last destructive change of the previous session (or the
  // discarded text), kept through a commit so a wipe-then-send can be undone.
  `ALTER TABLE drafts ADD COLUMN recovery_text TEXT`,
  `ALTER TABLE drafts ADD COLUMN recovery_at INTEGER`,
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

  // A draft goes when its target goes (garbage collection of pending chats). Draft
  // targets aren't foreign keys, since one column points into several tables.
  `CREATE TRIGGER drafts_gc_chat AFTER DELETE ON chats
    BEGIN DELETE FROM drafts WHERE target_kind = 'composer' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_version AFTER DELETE ON versions
    BEGIN DELETE FROM drafts WHERE target_kind = 'version_edit' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_slot AFTER DELETE ON slots
    BEGIN DELETE FROM drafts WHERE target_kind = 'scratchpad' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_summary AFTER DELETE ON summaries
    BEGIN DELETE FROM drafts WHERE target_kind = 'summary_edit' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_ref AFTER DELETE ON entity_refs
    BEGIN DELETE FROM drafts WHERE target_kind = 'entity_field' AND target_id = OLD.id; END`
]
