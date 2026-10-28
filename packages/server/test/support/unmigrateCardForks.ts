// Takes a database back to before migration 0056 (card forks): no relationship columns, indexes
// or triggers on entities. The migrator runs only what comes after the latest one applied, so
// a test that takes an earlier migration back first takes this one back (unmigrateForkVersions.ts).
import type { DatabaseSync } from "node:sqlite"
import { cardForks } from "../../src/db/schema/cardForks.ts"

export const unmigrateCardForks = (db: DatabaseSync) => {
  for (const statement of cardForks) {
    const trigger = /^CREATE TRIGGER (\w+)/.exec(statement)
    if (trigger) db.exec(`DROP TRIGGER IF EXISTS ${trigger[1]}`)
    const index = /^CREATE INDEX (\w+)/.exec(statement)
    if (index) db.exec(`DROP INDEX IF EXISTS ${index[1]}`)
  }
  db.exec(`ALTER TABLE entities DROP COLUMN forked_from_entity_id;
    ALTER TABLE entities DROP COLUMN forked_from_revision_id;
    ALTER TABLE entities DROP COLUMN forked_in_chat_id;
    ALTER TABLE entities DROP COLUMN forked_at;
    DELETE FROM effect_sql_migrations WHERE name = 'card_forks';`)
}
