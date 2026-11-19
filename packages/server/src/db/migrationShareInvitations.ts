// 0009_share_invitations (files4bfix; spec/FILES-AND-ENVIRONMENT.md §1.4, DESIGN §7.9): a share
// is bound to the folder it was made on, not to its path, and reaches the other account only once
// they accept it.
// - `file_shares.device` (with `inode`, 0002_files): the folder's identity. A share whose path
//   holds another folder, or none, doesn't resolve until its owner shares the folder there again.
// - `file_shares.suspended_at`: the folder went to the bin. Restoring it doesn't share it again.
// - `file_share_invitations`: a share offered and not yet accepted. `handle` is the name the owner
//   typed; `grantee_user_id` is the account it named when it was sent, NULL when none (the owner
//   is told the same either way, and the invitation never reaches anyone). An account made later
//   under that name never receives it.
// A released migration never changes, so its SQL is written out here.

export const shareInvitationsMigration: ReadonlyArray<string> = [
  `ALTER TABLE file_shares ADD COLUMN device INTEGER`,
  `ALTER TABLE file_shares ADD COLUMN suspended_at INTEGER`,
  `CREATE TABLE file_share_invitations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
    inode INTEGER,
    device INTEGER,
    handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 128),
    grantee_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
    created_at INTEGER NOT NULL,
    UNIQUE (owner_user_id, path, handle)
  ) STRICT`,
  `CREATE INDEX file_share_invitations_grantee ON file_share_invitations(grantee_user_id)`,
  `CREATE TRIGGER file_share_invitations_not_self BEFORE INSERT ON file_share_invitations
    WHEN NEW.owner_user_id = NEW.grantee_user_id BEGIN
    SELECT RAISE(ABORT, 'a folder is not shared with its owner');
  END`
]
