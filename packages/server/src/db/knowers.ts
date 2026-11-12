// Who knew a message, read from the database (spec/CHARACTER-CONTEXT.md §9.1): its version's
// cast less those away, and its speaker; a merge's join, those who knew all of it; nothing
// recorded, everyone. Shared by assembly (`assemblySources.ts`) and the agent's read tools
// (`agentReads.ts`), so both leave out the same messages. The pure rule is `@rp/shared/knowledge.ts`.
import { knowersOf, parsePresence } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import { viewedJoin } from "../assembler/mergeKnowledge.ts"
import type { SqlClient } from "effect/sql"
import type { Fragment } from "effect/sql/Statement"
import { effectiveOverride, type ForkRef } from "./forkState.ts"

/**
 * SQL: whether fork `fork` counts card expression `card` not present for slot `slot`'s message
 * (a `presence_away` override with flag 1: the played stretch of threads started at an earlier
 * message, spec/THREADS.md §5.2 step 5, [D] 2026-11-12). One probe of the fork's steps.
 */
export const correctedAwaySql = (sql: SqlClient.SqlClient, fork: ForkRef, slot: string, card: string) =>
  sql`coalesce((SELECT flag FROM fork_overrides
    WHERE id = ${effectiveOverride(sql, "presence_away", fork, `${slot} || ':' || ${card}`)}), 0) = 1`

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

/** Everyone who knew any of a merge's join at slot expression `slot`, as a JSON array. */
const mergePeopleSql = (slot: string) => `(SELECT json_group_array(DISTINCT candidate.entity) FROM (
  SELECT c.value ->> 'entity' AS entity FROM chat_merges m, json_each(m.cast_json) c
    WHERE m.slot_id = ${slot} AND c.value ->> 'from' <> 'destination'
  UNION SELECT k.value FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id = m.id,
    json_each(mm.knowers_json) k WHERE m.slot_id = ${slot}) candidate)`

/**
 * Whether the viewer knew the version `v` of slot `s` (SQL, both aliases in scope). `viewers` is
 * the viewer's identities: itself and the cards it replaced on this fork (`card.swap`). In fork
 * `fork` (when given), a card the fork counts not present for the message (`correctedAwaySql`)
 * didn't know it, unless it's the message's speaker; a message with no cast recorded stays
 * known to everyone.
 */
export const knowsSql = (sql: SqlClient.SqlClient, viewers: ReadonlyArray<string>, fork?: ForkRef) => {
  const ids = JSON.stringify(viewers)
  const kept =
    fork === undefined || fork === null
      ? sql`1`
      : sql`NOT EXISTS (SELECT 1 FROM json_each(${ids}) cv WHERE ${correctedAwaySql(sql, fork, "s.id", "cv.value")})`
  return sql`CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = s.id)
    THEN EXISTS (SELECT 1 FROM json_each(${sql.literal(mergeKnowersSql("s.id"))}) k WHERE k.value IN (SELECT value FROM json_each(${ids})))
      AND ${kept}
    ELSE v.cast_json IS NULL OR EXISTS (SELECT 1 FROM json_each(${ids}) viewer WHERE viewer.value = v.speaker_entity_id)
      OR (EXISTS (SELECT 1 FROM json_each(v.cast_json) c WHERE c.value IN (SELECT value FROM json_each(${ids}))
        AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(v.presence_json, '{}'), '$.away') a
          WHERE a.value = c.value)) AND ${kept}) END`
}

/**
 * Each version's knowers, in the order asked; null: known to everyone (or not found). Point
 * lookups by version id: the requested ids drive the query, never a scan of the chat. In fork
 * `fork` (when given), the cards it counts not present for a message are left out of its
 * knowers, its speaker apart (`knowsSql`'s rule): one probe per recorded knower, and none at
 * all in a chat without such corrections.
 */
export const readKnowers = (
  sql: SqlClient.SqlClient,
  chatId: string,
  owned: Fragment,
  versionIds: ReadonlyArray<string>,
  viewers?: ReadonlyArray<string> | null,
  fork?: ForkRef
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      id: string
      slot_id: string
      cast_json: string | null
      presence_json: string | null
      speaker_entity_id: string | null
      merge_cast: string | null
      merge_people: string | null
      merge_id: string | null
      merge_title: string | null
      content: string
    }>`SELECT metadata.id, metadata.slot_id, payload.content,
        (SELECT m.id FROM chat_merges m WHERE m.slot_id = metadata.slot_id) AS merge_id,
        (SELECT m.title FROM chat_merges m WHERE m.slot_id = metadata.slot_id) AS merge_title, payload.cast_json, payload.presence_json, metadata.speaker_entity_id,
        CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = metadata.slot_id) THEN ${sql.literal(mergeKnowersSql("metadata.slot_id"))} END AS merge_cast,
        CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = metadata.slot_id) THEN ${sql.literal(mergePeopleSql("metadata.slot_id"))} END AS merge_people
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
    const recorded = new Map(
      rows.map((row) => [
        row.id,
        row.merge_cast !== null
          ? (JSON.parse(row.merge_cast) as Array<string>)
          : knowersOf({
              cast: row.cast_json === null ? null : (JSON.parse(row.cast_json) as Array<string>),
              speaker: row.speaker_entity_id,
              presence: parsePresence(row.presence_json)
            })
      ])
    )
    // A join's candidates are everyone who knew any of it; a message's, its recorded knowers.
    const candidates = new Map(
      rows.map((row) => [
        row.id,
        row.merge_people !== null ? (JSON.parse(row.merge_people) as Array<string>) : recorded.get(row.id)!
      ])
    )
    const corrected = yield* correctedKnowers(sql, chatId, fork, rows, candidates)
    return versionIds.map((versionId) => {
      const row = byId.get(versionId)
      const all = row === undefined ? null : recorded.get(versionId)!
      const away = corrected.get(versionId)
      const knowers = all === null || away === undefined ? all : [...all].filter((id) => !away.includes(id))
      const merge = row?.merge_id ? merged.get(row.merge_id) : undefined
      const view =
        merge && viewers
          ? viewedJoin(row!.content, row!.merge_title!, merge, (ids) => viewers.some((id) => ids.includes(id)))
          : null
      return {
        versionId,
        knowers: knowers === null ? null : [...knowers],
        ...(away === undefined ? {} : { away }),
        ...(view ? { content: view.content, readable: view.rows.length > 0 || !view.partial } : {})
      }
    })
  })

/**
 * Of each version's candidates (its speaker apart), those fork `fork` counts not present for
 * the message, by version id: nothing to probe unless the chat has such a correction at all
 * (`fork_overrides_chat`).
 */
const correctedKnowers = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: ForkRef | undefined,
  rows: ReadonlyArray<{ readonly id: string; readonly slot_id: string; readonly speaker_entity_id: string | null }>,
  recorded: ReadonlyMap<string, Iterable<string> | null>
) =>
  Effect.gen(function* () {
    const none = new Map<string, Array<string>>()
    if (fork === undefined || fork === null || rows.length === 0) return none
    const [any] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM (SELECT 1 FROM fork_overrides
      WHERE chat_id = ${chatId} AND kind = 'presence_away' LIMIT 1)`
    if ((any?.n ?? 0) === 0) return none
    const pairs = rows.flatMap((row) =>
      [...(recorded.get(row.id) ?? [])]
        .filter((card) => card !== row.speaker_entity_id)
        .map((card) => ({ v: row.id, s: row.slot_id, e: card }))
    )
    if (pairs.length === 0) return none
    const found = yield* sql<{ v: string; e: string }>`SELECT p.value ->> 'v' AS v, p.value ->> 'e' AS e
      FROM json_each(${JSON.stringify(pairs)}) p
      WHERE ${correctedAwaySql(sql, fork, "(p.value ->> 's')", "(p.value ->> 'e')")}`
    const away = new Map<string, Array<string>>()
    for (const row of found) away.set(row.v, [...(away.get(row.v) ?? []), row.e])
    return away
  })

/**
 * The rows of these merges' joins a separate context lays out per viewer (unit C6), each
 * merge's
 in order, summarized rows left out. A row with no knowers recorded was known to the
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
