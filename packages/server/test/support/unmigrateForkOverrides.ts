// Takes a database back to before migration 0054 (fork overrides): no overrides, no lineage,
// and the version trigger reading only the slot's selection. Choices made in forks go with the
// overrides, and slots keep their own selections; a test that needs a selection the code before
// made writes it on the slot itself. Unit 3's migration test runs the migration
// again over what this leaves; it's also the first step of taking forks out
// (unmigrateForks.ts), since the overrides name forks. Migration 0055 goes first (unmigrateForkVersions.ts).
import type { DatabaseSync } from "node:sqlite"
import { historyChangesSchema } from "../../src/db/historyChanges.ts"
import { forkOverrides } from "../../src/db/schema/forkOverrides.ts"
import { unmigrateForkVersions } from "./unmigrateForkVersions.ts"

export const unmigrateForkOverrides = (db: DatabaseSync) => {
  unmigrateForkVersions(db)
  for (const statement of forkOverrides) {
    const trigger = /^CREATE TRIGGER (\w+)/.exec(statement)
    if (trigger) db.exec(`DROP TRIGGER IF EXISTS ${trigger[1]}`)
  }
  db.exec(historyChangesSchema.find((s) => s.includes("TRIGGER history_reduced_version"))!)
  db.exec(`DROP TABLE fork_overrides; ALTER TABLE forks DROP COLUMN lineage_json;
    UPDATE chats SET state_seq = 0;
    DELETE FROM effect_sql_migrations WHERE name = 'fork_overrides';`)
}
