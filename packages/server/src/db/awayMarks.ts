// The away marks on a branch's path, for the timeline's away rows (spec/CHARACTER-CONTEXT.md §5,
// §9.2 unit CU3): every `away.set` that applies on the fork's display path through the leaf, in
// fold order, where it was written and who set it: the scene check (`source: "decision"`), a
// character's own reply (`set_presence`, written by a rollout), or the user. The client keeps
// only the changes (left, back) and offers Undo on the scene check's (writer `CorrectPresence`).
import type { AwayMark } from "@dreamspan/shared/contextsApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { awayEventsThrough } from "./stateRead.ts"
import { query } from "./tx.ts"

export const makeAwayMarkReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    AwayMarks: ({ userId, chatId, forkId, slotId }) =>
      Effect.gen(function* () {
        const [fork] = yield* sql<{ readonly id: string }>`
          SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE f.id = ${forkId} AND f.chat_id = ${chatId} AND f.deleted_at IS NULL
            AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
        const rows = yield* awayEventsThrough(sql, chatId, slotId, fork.id)
        const versions = [...new Set(rows.flatMap((row) => (row.version_id === null ? [] : [row.version_id])))]
        const speakers = new Map(
          versions.length === 0
            ? []
            : (yield* sql<{ readonly id: string; readonly speaker_entity_id: string | null }>`
                SELECT id, speaker_entity_id FROM versions WHERE id IN ${sql.in(versions)}`).map(
                (row) => [row.id, row.speaker_entity_id] as const
              )
        )
        return rows.flatMap((row): Array<AwayMark> => {
          if (row.slot_id === null) return []
          const value = JSON.parse(row.value_json) as { entity: string; away: boolean; source?: "decision" }
          const by =
            value.source === "decision" ? "decision" : row.origin === "rollout" ? "character" : ("user" as const)
          const speaker = row.version_id === null ? null : (speakers.get(row.version_id) ?? null)
          return [
            {
              eventId: row.id,
              slotId: row.slot_id as AwayMark["slotId"],
              entityId: value.entity as AwayMark["entityId"],
              away: value.away,
              by,
              ...(by === "character" && speaker !== null ? { setBy: speaker as AwayMark["entityId"] } : {})
            }
          ]
        })
      }).pipe(query("AwayMarks"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
