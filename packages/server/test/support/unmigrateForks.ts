// Takes a database back to before migration 0053 (forks), as the code before it left one:
// branch names on the slots that start them, composer drafts keyed by their fork's tip, and
// no forks. Migration tests build their fixtures with today's writer, then run the
// migration again over what this leaves.
import type { DatabaseSync } from "node:sqlite"
import { forkTables, forkTriggers } from "../../src/db/schema/forks.ts"
import { unmigrateForkOverrides } from "./unmigrateForkOverrides.ts"

const names = (statements: ReadonlyArray<string>, pattern: RegExp) =>
  statements.flatMap((statement) => {
    const match = pattern.exec(statement)
    return match ? [match[1]!] : []
  })

export const unmigrateForks = (db: DatabaseSync) => {
  unmigrateForkOverrides(db)
  db.exec(`
    UPDATE slots SET branch_name = f.name, branch_name_user = f.name_user FROM forks f
    WHERE slots.fork_id = f.id AND slots.parent_slot_id IS f.base_slot_id AND f.name IS NOT NULL;
    UPDATE drafts SET field = coalesce((SELECT tip_slot_id FROM forks WHERE id = drafts.field), '')
    WHERE target_kind = 'composer';`)
  for (const name of names(forkTriggers, /^CREATE TRIGGER (\w+)/)) db.exec(`DROP TRIGGER ${name}`)
  for (const name of names(forkTables, /^CREATE INDEX (\w+) ON (?!forks\()/)) db.exec(`DROP INDEX ${name}`)
  for (const statement of forkTables) {
    const added = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(statement)
    if (added) db.exec(`ALTER TABLE ${added[1]} DROP COLUMN ${added[2]}`)
  }
  db.exec(`DROP TABLE forks; DELETE FROM effect_sql_migrations WHERE name = 'forks';`)
}
