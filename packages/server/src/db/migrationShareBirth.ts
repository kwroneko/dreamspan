// 0010_share_birth (files5; spec/FILES-AND-ENVIRONMENT.md §1.4):
// - `birth_ms` on shares and invitations: the shared folder's birth time (statx btime) when the
//   filesystem gives one, NULL when it doesn't. With inode and device it is the folder's identity,
//   so a folder deleted and recreated under a reused inode number never inherits the share. A row
//   without one (made before this, or on a filesystem with no birth time) is checked by inode and
//   device alone.
// - `declined_at` on invitations: a declined invitation stays for its owner exactly as one sent
//   to a name with no account does, and no longer shows for the account that declined it.
// A released migration never changes, so its SQL is written out here.

export const shareBirthMigration: ReadonlyArray<string> = [
  `ALTER TABLE file_shares ADD COLUMN birth_ms REAL`,
  `ALTER TABLE file_share_invitations ADD COLUMN birth_ms REAL`,
  `ALTER TABLE file_share_invitations ADD COLUMN declined_at INTEGER`
]
