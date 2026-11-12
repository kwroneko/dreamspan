// Who knew a message, read from the database (spec/CHARACTER-CONTEXT.md §9.1): its version's
// cast less those away, and its speaker; a merge's join, those who knew all of it; nothing
// recorded, everyone. Shared by assembly (`assemblySources.ts`) and the agent's read tools
// (`agentReads.ts`), so both leave out the same messages. The pure rule is `@rp/shared/knowledge.ts`.
import { knowersOf, parsePresence } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import { viewedJoin } from "../assembler/mergeKnowledge.ts"
import type { SqlClient } from "effect/sql"
import type { Fragment } from "effect/sql/Statement"

/**
 * Who knew a merge's join at slot expression `slot`, as a JSON array: until C6 renders individual
 * frozen rows, those of the source's cast or the rows' knowers who knew every sent row.
 */
const mergeKnowersSql = (slot: string) => `(SELECT json_group_array(candidate.entity) FROM (
  SELECT c.value ->> 'entity' AS entity FROM chat_merges m, json_each(m.cast_json) c
    WHERE m.slot_id = ${slot} AND c.value ->> 'from' <> 'destination'
  UNION SELECT k.value FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id = m.id,
    json_each(mm.knowers_json) k WHERE m.slot_id = ${slot}
) candidate WHERE NOT EXISTS (
  SELECT 1 FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id = m.id
  WHERE m.slot_id = ${slot} AND mm.included = 'verbatim' AND mm.knowers_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(mm.knowers_json) k WHERE k.value = candidate.entity)))`

/**
 * Whether the viewer knew the version `v` of slot `s` (SQL, both aliases in scope). `viewers` is
 * the viewer's identities: itself and the cards it replaced on this fork (`card.swap`).
 */
export const knowsSql = (sql: SqlClient.SqlClient, viewers: ReadonlyArray<string>) => {
  const ids = JSON.stringify(viewers)
  return sql`CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = s.id)
    THEN EXISTS (SELECT 1 FROM json_each(${sql.literal(mergeKnowersSql("s.id"))}) k WHERE k.value IN (SELECT value FROM json_each(${ids})))
    ELSE v.cast_json IS NULL OR EXISTS (SELECT 1 FROM json_each(${ids}) viewer WHERE viewer.value = v.speaker_entity_id)
      OR EXISTS (SELECT 1 FROM json_each(v.cast_json) c WHERE c.value IN (SELECT value FROM json_each(${ids}))
        AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(v.presence_json, '{}'), '$.away') a
          WHERE a.value = c.value)) END`
}

/**
 * Each version's knowers, in the order asked; null: known to everyone (or not found). Point
 * lookups by version id: the requested ids drive the query, never a scan of the chat.
 */
export const readKnowers = (
  sql: SqlClient.SqlClient,
  chatId: string,
  owned: Fragment,
  versionIds: ReadonlyArray<string>,
  viewers?: ReadonlyArray<string> | null
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      id: string
      cast_json: string | null
      presence_json: string | null
      speaker_entity_id: string | null
      merge_cast: string | null
      merge_id: string | null
      merge_title: string | null
      content: string
    }>`SELECT metadata.id, payload.content,
        (SELECT m.id FROM chat_merges m WHERE m.slot_id = metadata.slot_id) AS merge_id,
        (SELECT m.title FROM chat_merges m WHERE m.slot_id = metadata.slot_id) AS merge_title, payload.cast_json, payload.presence_json, metadata.speaker_entity_id,
        CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = metadata.slot_id) THEN ${sql.literal(mergeKnowersSql("metadata.slot_id"))} END AS merge_cast
      FROM json_each(${JSON.stringify(versionIds)}) requested
      CROSS JOIN versions metadata ON metadata.id = requested.value
      CROSS JOIN version_texts payload ON payload.version_seq = metadata.seq
      CROSS JOIN slots s ON s.id = metadata.slot_id
      WHERE s.chat_id = ${chatId} AND ${owned}`
    const merges = viewers == null ? [] : rows.flatMap((r) => (r.merge_id ? [r.merge_id] : []))
    const merged = new Map(
      merges.length ? (yield* readMergeRows(sql, chatId, owned, merges)).map((m) => [m.mergeId, m.rows]) : []
    )
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
      const merge = row?.merge_id ? merged.get(row.merge_id) : undefined
      const view =
        merge && viewers
          ? viewedJoin(row!.content, row!.merge_title!, merge, (ids) => viewers.some((id) => ids.includes(id)))
          : null
      return {
        versionId,
        knowers: knowers === null ? null : [...knowers],
        ...(view ? { content: view.content, readable: view.rows.length > 0 || !view.partial } : {})
      }
    })
  })

/**
 * The rows of these merges' joins a separate context lays out per viewer (unit C6), each
 * merge's in order, summarized rows left out. A row with no knowers recorded was known to the
 * source's cast. Point lookups by merge id.
 */
export const readMergeRows = (
  sql: SqlClient.SqlClient,
  chatId: string,
  owned: Fragment,
  mergeIds: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      merge_id: string
      ordinal: number
      kind: "message" | "summary"
      speaker_name: string
      side: "user" | "assistant"
      speaker_entity_id: string | null
      content: string
      included: "verbatim" | "left_out"
      knowers: string
    }>`SELECT m.id AS merge_id, mm.ordinal, mm.kind, mm.speaker_name, mm.side, mm.speaker_entity_id,
        CASE WHEN mm.included = 'verbatim' THEN mm.content ELSE '' END AS content, mm.included,
        coalesce(mm.knowers_json, (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c
          WHERE c.value ->> 'from' <> 'destination')) AS knowers
      FROM json_each(${JSON.stringify(mergeIds)}) requested
      CROSS JOIN chat_merges m ON m.id = requested.value
      CROSS JOIN chat_merge_messages mm ON mm.merge_id = m.id
      WHERE m.chat_id = ${chatId} AND mm.included <> 'summarized' AND ${owned}
      ORDER BY m.id, mm.ordinal`
    return mergeIds.map((mergeId) => ({
      mergeId,
      rows: rows
        .filter((row) => row.merge_id === mergeId)
        .map((row) => ({
          ordinal: row.ordinal,
          kind: row.kind,
          name: row.speaker_name,
          side: row.side,
          speaker: row.speaker_entity_id,
          content: row.content,
          included: row.included,
          knowers: JSON.parse(row.knowers) as Array<string>
        }))
    }))
  })
