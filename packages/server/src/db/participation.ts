// Historical membership belongs to authored versions, not to the mutable cast. These
// helpers run inside the caller's worker transaction; the schema indexes their snapshots.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { presenceOf, type VersionPresence } from "@rp/shared/knowledge.ts"
import { foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayThrough, slotAtPosition } from "./displayPath.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"

/**
 * What a version written at a position records: the cast connected there (`cast_json`) and who
 * of it was away or a narrator (`presence_json`, spec/CHARACTER-CONTEXT.md §9.1).
 */
export interface PositionalCast {
  readonly cast: ReadonlyArray<string>
  readonly presence: VersionPresence | null
}

export const presenceAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string | null,
  fork: string | null
) {
  const rows = yield* stateEventsThrough(sql, chatId as ChatId, leaf as SlotId | null, fork)
  const state = foldState(
    yield* withoutPurged(
      sql,
      rows.map((e) => ({
        scope: e.scope,
        data: { key: e.key, value: JSON.parse(e.value_json) }
      })) as Array<FoldableEvent>
    )
  )
  const at: PositionalCast = { cast: state.participants, presence: presenceOf(state, state.participants) }
  return at
})

export const castAt = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null, fork: string | null) =>
  Effect.map(presenceAt(sql, chatId, leaf, fork), (at) => at.cast)

/** The state before an existing slot on this fork's display path, including earlier insertions. */
export const presenceBefore = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  slotId: string,
  fork: string
) {
  const [row] = yield* sql<{ parent_slot_id: string | null }>`SELECT parent_slot_id FROM slots WHERE id = ${slotId}`
  const shown = yield* displayThrough(sql, chatId, fork, slotId)
  const leaf =
    shown === null
      ? row!.parent_slot_id
      : shown.end === 0
        ? null
        : yield* slotAtPosition(sql, shown.pieces, shown.end - 1)
  return yield* presenceAt(sql, chatId, leaf, fork)
})

/** The stored form of a presence record: NULL when nobody was away and none narrated. */
export const presenceJson = (presence: VersionPresence | null) => (presence === null ? null : JSON.stringify(presence))

/** Every retained swipe at a position is evidence, selected or not. Copies retain its cast. */
export const slotParticipantsSql = (slot: string) => `(SELECT json_group_array(entity_id) FROM (
  SELECT p.entity_id
  FROM versions pv JOIN version_participants p ON p.version_id = pv.id
    JOIN entities pe ON pe.id = p.entity_id AND pe.purged_at IS NULL
  WHERE pv.slot_id = ${slot}.id AND pv.purged_at IS NULL
  GROUP BY p.entity_id ORDER BY min(pv.ordinal), p.entity_id))`

/** Human-authored alternatives count as use even when another swipe is selected. */
export const slotHumanAuthorsSql = (slot: string) => `(SELECT json_group_array(json_object(
  'entity', v.speaker_entity_id, 'at', CASE WHEN v.origin IN ('edited', 'changeset')
    THEN ${slot}.created_at ELSE v.created_at END) ORDER BY v.ordinal)
  FROM versions v WHERE v.slot_id = ${slot}.id AND v.writer = 'human'
    AND v.speaker_entity_id IS NOT NULL AND v.purged_at IS NULL)`
