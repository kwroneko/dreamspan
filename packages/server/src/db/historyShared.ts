import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { effectiveOverride, replacedIn, eventApplies } from "./forkState.ts"
import { onForkPath } from "./forks.ts"
import type { HistoryEdit } from "@dreamspan/shared/historyApi.ts"

export const historyFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  forkId: string
) {
  const [fork] = yield* sql<{ id: string; chat_id: string; tip_slot_id: string | null }>`
    SELECT f.* FROM forks f JOIN chats c ON c.id=f.chat_id WHERE f.id=${forkId} AND c.id=${chatId}
      AND c.owner_user_id=${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL AND f.purged_at IS NULL`
  if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
  return fork
})

export const historySummaryRevision = (sql: SqlClient.SqlClient, forkId: string, alias: string) => sql`
  coalesce((SELECT value_id FROM fork_overrides WHERE id=${effectiveOverride(sql, "summary_revision", forkId, `${alias}.id`)}), ${sql.literal(`${alias}.selected_revision_id`)})`

/**
 * Current text and stable original key. A submitted copy never grants access to a different
 * path: the target's message (a summary's first and last) must be on the fork's display path,
 * so an inserted message counts only in the forks that show it (spec/MESSAGE-INSERT.md §3.3).
 */
export const historyCurrent = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  fork: { id: string; chat_id: string; tip_slot_id: string | null },
  edit: Pick<HistoryEdit, "kind" | "targetId">
) {
  if (edit.kind === "version_replace") {
    const [base] = yield* sql<{
      slot_id: string
    }>`SELECT slot_id FROM versions WHERE id=${edit.targetId} AND fork_id IS NULL`
    if (base && (yield* onForkPath(sql, fork.chat_id, fork, base.slot_id))) {
      const id = replacedIn(sql, fork.id, "'" + edit.targetId.replaceAll("'", "''") + "'")
      const [row] = yield* sql<{
        id: string
        content: string
        slot_id: string
      }>`SELECT id, content, slot_id FROM version_records WHERE id=${id}`
      return row ?? null
    }
  } else if (edit.kind === "state_event") {
    const [base] = yield* sql<{ id: string; slot_id: string | null }>`SELECT e.id, e.slot_id FROM state_events e
      LEFT JOIN fork_overrides o ON o.id=${effectiveOverride(sql, "suppress_event", fork.id, "e.id")}
      WHERE e.id=${edit.targetId} AND e.chat_id=${fork.chat_id}
        AND (${eventApplies(sql, fork.id, "e")} OR (o.changeset_id IS NOT NULL AND o.value_id IS NOT NULL))`
    if (!base || (base.slot_id !== null && !(yield* onForkPath(sql, fork.chat_id, fork, base.slot_id)))) return null
    const [row] = yield* sql<{ id: string; content: string; slot_id: string | null }>`SELECT e.id,
      json_object('scope',e.scope,'data',json_object('key',e.key,'value',json(e.value_json))) AS content, e.slot_id
      FROM state_events e WHERE e.id=coalesce((SELECT value_id FROM fork_overrides WHERE id=${effectiveOverride(sql, "suppress_event", fork.id, "'" + edit.targetId.replaceAll("'", "''") + "'")}),${edit.targetId})`
    return row ?? null
  } else {
    const [row] = yield* sql<{ id: string; content: string; slot_id: string; last_slot_id: string }>`
      SELECT r.id, r.content, s.first_slot_id AS slot_id, s.last_slot_id FROM summaries s
        JOIN summary_revisions r ON r.id=${historySummaryRevision(sql, fork.id, "s")}
      WHERE s.id=${edit.targetId} AND s.chat_id=${fork.chat_id} AND s.sealed=1`
    if (
      row &&
      (yield* onForkPath(sql, fork.chat_id, fork, row.slot_id)) &&
      (yield* onForkPath(sql, fork.chat_id, fork, row.last_slot_id))
    )
      return row
  }
  return null
})
