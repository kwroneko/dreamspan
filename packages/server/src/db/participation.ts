// Historical membership belongs to authored versions, not to the mutable cast. These
// helpers run inside the caller's worker transaction; the schema indexes their snapshots.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"

export const castAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string | null,
  fork: string | null
) {
  const rows = yield* stateEventsThrough(sql, chatId as ChatId, leaf as SlotId | null, fork)
  return foldState(
    yield* withoutPurged(
      sql,
      rows.map((e) => ({
        scope: e.scope,
        data: { key: e.key, value: JSON.parse(e.value_json) }
      })) as Array<FoldableEvent>
    )
  ).participants
})

/** Every retained swipe at a position is evidence, selected or not. Copies retain its cast. */
export const slotParticipantsSql = (slot: string) => `(SELECT json_group_array(DISTINCT p.entity_id)
  FROM versions pv JOIN version_participants p ON p.version_id = pv.id
    JOIN entities pe ON pe.id = p.entity_id AND pe.purged_at IS NULL
  WHERE pv.slot_id = ${slot}.id AND pv.purged_at IS NULL)`

/** Human-authored alternatives count as use even when another swipe is selected. */
export const slotHumanAuthorsSql = (slot: string) => `(SELECT json_group_array(json_object(
  'entity', v.speaker_entity_id, 'at', CASE WHEN v.origin IN ('edited', 'changeset')
    THEN ${slot}.created_at ELSE v.created_at END))
  FROM versions v WHERE v.slot_id = ${slot}.id AND v.writer = 'human'
    AND v.speaker_entity_id IS NOT NULL AND v.purged_at IS NULL)`
