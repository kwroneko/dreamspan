import type { SqlClient } from "effect/sql"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { pathEvents } from "./pathSegments.ts"
import { attachedApplies, eventApplies, eventOrder, slotDeletedIn } from "./forkState.ts"

/**
 * The state events that apply at `slotId` (StateEventsAt) in fork `fork` (null: the chat's current fork), in fold order: chat-wide ones, then by depth. An
 * event attached to a version applies while the fork shows it. Its cost is the path's
 * segments and events, not its length.
 */
export const stateEventsOnPath = (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  slotId: SlotId | null,
  fork: string | null = null
) => {
  const view = fork ?? sql`(SELECT current_fork_id FROM chats WHERE id = ${chatId})`
  return sql<{ key: string; scope: string | null; value_json: string }>`
    ${pathEvents(sql, chatId, slotId)}
    SELECT ev.key, ev.scope, ev.value_json
    FROM path_events ev LEFT JOIN slots s ON s.id = ev.slot_id
    WHERE ${eventApplies(sql, view, "ev")}
      AND (ev.slot_id IS NULL OR NOT ${slotDeletedIn(sql, view, "s")})
      AND ${attachedApplies(sql, view, "s", "ev.version_id")}
    ORDER BY ${sql.literal(eventOrder("ev"))}`
}
