// What a user owns stays theirs (DESIGN §11), for every table with an owner column, not
// only the ones 0010 covered: one UPDATE could otherwise hand a credential (with its
// key), a session, a draft or a bin item to someone else. Nothing writes owners after
// insert, so they're simply immutable. A ref never moves to another entity either.
const raise = (message: string) => `SELECT RAISE(ABORT, '${message}')`

const owned: ReadonlyArray<readonly [table: string, column: string]> = [
  ["credentials", "owner_user_id"],
  ["sessions", "user_id"],
  ["drafts", "user_id"],
  ["bin_items", "user_id"],
  ["recovered_texts", "user_id"],
  ["user_prefs", "user_id"],
  ["user_settings", "user_id"],
  ["media_refs", "owner_user_id"],
  ["jobs", "owner_user_id"],
  ["llm_requests", "owner_user_id"]
]

export const ownership = [
  ...owned.map(
    ([table, column]) => `CREATE TRIGGER ${table}_owner_fixed BEFORE UPDATE OF ${column} ON ${table}
      WHEN NEW.${column} IS NOT OLD.${column}
      BEGIN ${raise(`${table} never change owner`)}; END`
  ),
  `CREATE TRIGGER entity_refs_entity_fixed BEFORE UPDATE OF entity_id ON entity_refs
    WHEN NEW.entity_id IS NOT OLD.entity_id
    BEGIN ${raise("a ref never moves to another entity")}; END`
]
