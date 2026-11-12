// Undo of an away mark the scene check set (spec/CHARACTER-CONTEXT.md §5 [P], §9.2 unit C9).
// In one writer transaction: the decision's `away.set` stops applying, the user's own presence
// event (the character present) takes its place at the same message, and the versions written
// since that recorded the character away because of it are corrected to count it present, so
// its later replies see those messages (assembly and the tools read `presence_json`).
import type { ChatId, EntityId, ForkId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { parsePresence, type VersionPresence } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { eventApplies, writeOverride } from "./forkState.ts"
import type { makeGraphWrites } from "./graphWrites.ts"
import { presenceJson } from "./participation.ts"

/**
 * [P] default for an open question (spec/CHARACTER-CONTEXT.md §9.3 item 4): an Undo corrects
 * every branch showing the mark. False keeps it to the branch it was undone in: the mark stops
 * applying there only, and only versions written there are corrected (a version two branches
 * show is shared, so one written elsewhere keeps its record; a per-branch record would need a
 * fork-scoped override, spec §9.4).
 */
const UNDO_CORRECTS_EVERY_BRANCH = true

/** The away list less `entity`; null when nothing is left to record. */
const without = (presence: VersionPresence | null, entity: string): VersionPresence | null => {
  const away = (presence?.away ?? []).filter((id) => id !== entity)
  const narrators = presence?.narrators ?? []
  if (away.length === 0 && narrators.length === 0) return null
  return {
    ...(away.length ? { away } : {}),
    ...(narrators.length ? { narrators } : {})
  }
}

export const correctPresence =
  (sql: SqlClient.SqlClient, graph: ReturnType<typeof makeGraphWrites>) =>
  ({
    userId,
    chatId,
    forkId,
    eventId
  }: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly forkId: ForkId
    readonly eventId: string
  }) =>
    Effect.gen(function* () {
      const [event] = yield* sql<{
        readonly slot_id: string | null
        readonly version_id: string | null
        readonly scope: string | null
        readonly entity: string
      }>`SELECT e.slot_id, e.version_id, e.scope, e.value_json ->> '$.entity' AS entity
        FROM state_events e JOIN chats c ON c.id = e.chat_id
        WHERE e.id = ${eventId} AND e.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
          AND e.key = 'away.set' AND e.value_json ->> '$.away' = 1 AND e.value_json ->> '$.source' = 'decision'
          AND ${eventApplies(sql, forkId, "e")}`
      if (!event || event.slot_id === null) return null
      const forks = UNDO_CORRECTS_EVERY_BRANCH
        ? yield* sql<{ readonly id: string }>`SELECT id FROM forks WHERE chat_id = ${chatId} AND deleted_at IS NULL`
        : [{ id: forkId }]
      // The user's word in its place, in the branch it was undone in: the character was there.
      const replacement = yield* graph.insertStateEvent(
        userId,
        chatId,
        event.slot_id,
        event.version_id,
        event.scope as never,
        { key: "away.set", value: { entity: event.entity as EntityId, away: false } },
        forkId
      )
      for (const fork of forks)
        yield* writeOverride(
          sql,
          { id: fork.id, chatId },
          { kind: "suppress_event", targetId: eventId, slotId: event.slot_id, valueId: replacement.id, flag: 1 }
        )
      // The messages written since, below the mark, until a later live away mark for the same
      // character takes over (its slot's own versions still count; below it, that mark decides).
      const rows = yield* sql<{ readonly id: string; readonly presence_json: string }>`
        WITH RECURSIVE region(id) AS (
          SELECT id FROM slots WHERE parent_slot_id = ${event.slot_id}
          UNION ALL
          SELECT c.id FROM slots c JOIN region r ON c.parent_slot_id = r.id
          WHERE NOT EXISTS (SELECT 1 FROM state_events o WHERE o.slot_id = r.id AND o.key = 'away.set'
            AND o.id <> ${eventId} AND o.id <> ${replacement.id} AND o.superseded_by_changeset IS NULL
            AND o.value_json ->> '$.entity' = ${event.entity})
        )
        SELECT v.id, v.presence_json FROM region r JOIN version_records v ON v.slot_id = r.id
        WHERE v.presence_json IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(v.presence_json, '$.away') a WHERE a.value = ${event.entity})
          AND (${UNDO_CORRECTS_EVERY_BRANCH ? 1 : 0} = 1 OR v.fork_id IS ${forkId}
            OR EXISTS (SELECT 1 FROM rollouts g WHERE g.id = v.rollout_id AND g.fork_id IS ${forkId}))`
      for (const row of rows)
        yield* sql`UPDATE version_records SET presence_json = ${presenceJson(
          without(parsePresence(row.presence_json), event.entity)
        )} WHERE id = ${row.id}`
      return { eventId: replacement.id, corrected: rows.map((row) => row.id as VersionId) }
    })
