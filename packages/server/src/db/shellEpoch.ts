// A display snapshot's invalidation token. Only owner metadata is read: no paths,
// swipes, document prose or summary persistence. Runs in a reader transaction.
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const makeShellEpoch = (sql: SqlClient.SqlClient) => {
  let version: number | undefined
  const epochs = new Map<string, string>()
  return (userId: string) =>
    Effect.gen(function* () {
      const [current] = yield* sql<{ data_version: number }>`PRAGMA data_version`
      if (version !== current!.data_version) {
        version = current!.data_version
        epochs.clear()
      }
      const known = epochs.get(userId)
      if (known !== undefined) return known
      const stamps = yield* sql`SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}`
      const chats = yield* sql`SELECT id, kind, title, current_fork_id, created_at, added_at, shell_stamp
    FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL ORDER BY id`
      const forks = yield* sql`SELECT f.id, f.chat_id, f.parent_fork_id, f.base_slot_id, f.tip_slot_id,
      f.name, f.pinned_at, f.last_chatted_at, f.created_at, f.deleted_at, f.purged_at, f.split_chat
    FROM chats c CROSS JOIN forks f ON f.chat_id = c.id
    WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL ORDER BY f.id`
      const cards = yield* sql`SELECT e.id, e.archived_at, e.created_at, r.created_at AS added_at,
      r.id AS ref, r.label, r.head_revision_id, cs.fields, cs.book, cs.book_entries,
      EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
    FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id LIMIT 1)
    LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL
    ORDER BY e.id`
      const pins = yield* sql`SELECT chat_id FROM chat_pins WHERE user_id = ${userId} ORDER BY chat_id`
      const prefs = yield* sql`SELECT key, value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId}
    AND key IN ('shell.pinsCollapsed', 'cards.favourites') ORDER BY key`
      const threads = yield* sql`SELECT m.split_id, m.ordinal, m.name, m.name_user, m.row_version
    FROM chats c CROSS JOIN thread_splits x ON x.chat_id = c.id CROSS JOIN thread_members m ON m.split_id = x.id
    WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL ORDER BY m.split_id, m.ordinal`
      const epoch = createHash("sha256")
        .update(JSON.stringify([stamps, chats, forks, cards, pins, prefs, threads]))
        .digest("hex")
      epochs.set(userId, epoch)
      return epoch
    })
}
