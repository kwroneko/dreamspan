// Takes a database back to before migration 0055 (fork versions): no fork's copies, flags or
// replacements, and versions' flags writable again. A test that needs a flag the code before
// set writes it on the version itself. Unit 4's migration test runs the migration again over
// what this leaves; it's also the first step of taking the overrides out
// (unmigrateForkOverrides.ts), since the migrations run in order.
import type { DatabaseSync } from "node:sqlite"
import { forkVersions } from "../../src/db/schema/forkVersions.ts"

export const unmigrateForkVersions = (db: DatabaseSync) => {
  for (const statement of forkVersions) {
    const trigger = /^CREATE TRIGGER (\w+)/.exec(statement)
    if (trigger) db.exec(`DROP TRIGGER IF EXISTS ${trigger[1]}`)
    const index = /^CREATE INDEX (\w+)/.exec(statement)
    if (index) db.exec(`DROP INDEX IF EXISTS ${index[1]}`)
  }
  db.exec(`DELETE FROM fork_overrides WHERE kind IN ('replace', 'star', 'picker_hide');
    DELETE FROM versions WHERE fork_id IS NOT NULL;
    ALTER TABLE versions DROP COLUMN fork_id;
    DELETE FROM effect_sql_migrations WHERE name = 'fork_versions';`)
}
