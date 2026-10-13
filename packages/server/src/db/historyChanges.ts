import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/** Sparse durable reductions; ordinary appends never enter this index. */
export const historyRevision = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null,
  before: number
) => sql<{ revision: number }>`
  WITH RECURSIVE changes AS MATERIALIZED (
    SELECT slot_id, depth, revision FROM history_changes INDEXED BY history_changes_depth
    WHERE chat_id = ${chatId} AND depth < ${before}
      AND EXISTS (SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL)
  ), path(id, depth) AS MATERIALIZED (
    SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND EXISTS (SELECT 1 FROM changes)
    UNION ALL
    SELECT s.parent_slot_id, p.depth - 1 FROM path p JOIN slots s ON s.id = p.id
    WHERE p.depth > (SELECT min(depth) FROM changes)
  )
  SELECT coalesce(sum(revision), 0) AS revision FROM changes WHERE slot_id IN (SELECT id FROM path)`

/** Use the assembler's UTF-16 length, including astral characters and embedded NULs. */
export const recordHistoryReduction = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  slotId: string,
  content: string,
  versionId: string | null = null
) {
  const [previous] = yield* sql<{ content: Uint8Array }>`
    SELECT CAST(v.content AS BLOB) AS content FROM slots s JOIN versions v ON v.id = s.selected_version_id
    WHERE s.id = ${slotId} AND (${versionId} IS NULL OR v.id = ${versionId})`
  if (previous && content.length < Buffer.from(previous.content).toString("utf8").length)
    yield* sql`INSERT INTO history_changes SELECT id, chat_id, depth, 1 FROM slots WHERE id = ${slotId}
      ON CONFLICT(slot_id) DO UPDATE SET revision = revision + 1`
})

export const historyChangesSchema = [
  `CREATE TABLE history_changes (
    slot_id TEXT PRIMARY KEY REFERENCES slots(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL,
    revision INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX history_changes_depth ON history_changes(chat_id, depth)`,
  `CREATE TRIGGER history_reduced_slot AFTER UPDATE OF deleted_at, context_excluded ON slots
    WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
      OR (OLD.context_excluded = 0 AND NEW.context_excluded = 1)

    BEGIN
      INSERT INTO history_changes VALUES (NEW.id, NEW.chat_id, NEW.depth, 1)
      ON CONFLICT(slot_id) DO UPDATE SET revision = revision + 1;
    END`,
  `CREATE TRIGGER history_reduced_version AFTER UPDATE OF deleted_at ON versions
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      INSERT INTO history_changes
        SELECT id, chat_id, depth, 1 FROM slots WHERE id = NEW.slot_id AND selected_version_id = NEW.id
      ON CONFLICT(slot_id) DO UPDATE SET revision = revision + 1;
    END`
]
