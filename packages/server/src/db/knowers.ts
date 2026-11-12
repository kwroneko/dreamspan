// Who knew a message, read from the database (spec/CHARACTER-CONTEXT.md §9.1): its version's
// cast less those away, and its speaker; a merge's join, its source's cast; nothing recorded,
// everyone. Shared by assembly (`assemblySources.ts`) and the agent's read tools (`agentReads.ts`),
// so both leave out the same messages. The pure rule is `@rp/shared/knowledge.ts`.
import { knowersOf, parsePresence } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Fragment } from "effect/sql/Statement"

/** Whether `viewer` knew the version `v` of slot `s` (SQL, both aliases in scope). */
export const knowsSql = (sql: SqlClient.SqlClient, viewer: string) =>
  sql`CASE WHEN v.origin = 'merge' AND EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = s.id)
    THEN EXISTS (SELECT 1 FROM chat_merges m, json_each(m.cast_json) c WHERE m.slot_id = s.id
      AND c.value ->> 'from' <> 'destination' AND c.value ->> 'entity' = ${viewer})
    ELSE v.cast_json IS NULL OR v.speaker_entity_id IS ${viewer}
      OR (EXISTS (SELECT 1 FROM json_each(v.cast_json) c WHERE c.value = ${viewer})
        AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(v.presence_json, '{}'), '$.away') a
          WHERE a.value = ${viewer})) END`

/** Each version's knowers, in the order asked; null: known to everyone (or not found). */
export const readKnowers = (
  sql: SqlClient.SqlClient,
  chatId: string,
  owned: Fragment,
  versionIds: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const rows =
      versionIds.length === 0
        ? []
        : yield* sql<{
            id: string
            cast_json: string | null
            presence_json: string | null
            speaker_entity_id: string | null
            merge_cast: string | null
          }>`SELECT v.id, v.cast_json, v.presence_json, v.speaker_entity_id,
            CASE WHEN v.origin = 'merge' THEN (SELECT json_group_array(c.value ->> 'entity')
              FROM chat_merges m, json_each(m.cast_json) c
              WHERE m.slot_id = v.slot_id AND c.value ->> 'from' <> 'destination') END AS merge_cast
          FROM version_records v JOIN slots s ON s.id = v.slot_id
          WHERE s.chat_id = ${chatId} AND ${owned} AND v.id IN ${sql.in(versionIds)}`
    const byId = new Map(rows.map((row) => [row.id, row]))
    return versionIds.map((versionId) => {
      const row = byId.get(versionId)
      const knowers =
        row === undefined
          ? null
          : row.merge_cast !== null
            ? (JSON.parse(row.merge_cast) as Array<string>)
            : knowersOf({
                cast: row.cast_json === null ? null : (JSON.parse(row.cast_json) as Array<string>),
                speaker: row.speaker_entity_id,
                presence: parsePresence(row.presence_json)
              })
      return { versionId, knowers: knowers === null ? null : [...knowers] }
    })
  })
