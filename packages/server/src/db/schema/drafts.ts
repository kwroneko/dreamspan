// Draft history as rows instead of a blob (DESIGN §6.2): one reversible patch per entry,
// appended or extended in place, so a save never rewrites the whole history.

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
  ) STRICT, WITHOUT ROWID`
]
