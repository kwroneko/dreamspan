// Who knew a message, read from the database (spec/CHARACTER-CONTEXT.md §9.1): its version's
// cast less those away, and its speaker; a merge's join, those who knew all of it; nothing
// recorded, everyone. Shared by assembly (`assemblySources.ts`) and the agent's read tools
// (`agentReads.ts`), so both leave out the same messages. The pure rule is `@rp/shared/knowledge.ts`.
import { knowersOf, parsePresence, STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import { viewedJoin } from "../assembler/mergeKnowledge.ts"
import type { SqlClient } from "effect/sql"
import type { Fragment } from "effect/sql/Statement"
import { effectiveOverride, type ForkRef } from "./forkState.ts"
import { threadStretches, stretchedSql } from "./threadStretches.ts"

/**
 * SQL: whether fork `fork` counts card expression `card` not present for slot `slot`'s message
 * (a `presence_away` override with flag 1: the played stretch of threads started at an earlier
 * message, spec/THREADS.md §5.2 step 5, [D] 2026-11-12). One probe of the fork's steps.
 */
const correctedAwaySql = (sql: SqlClient.SqlClient, fork: ForkRef, slot: string, card: string) =>
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

/** Whether these identities are a stretch view's (`STRETCH_VIEW`, resolved by `threadStretches`). */
export const isStretchView = (identities: ReadonlyArray<string> | undefined) =>
  identities !== undefined && identities.includes(STRETCH_VIEW)

/**
 * Whether the viewer knew the version `v` of slot `s` (SQL, both aliases in scope). `viewers` is
 * the viewer's identities: itself and the cards it replaced on this fork (`card.swap`). In fork
 * `fork` (when given), a card the fork counts not present for the message (`correctedAwaySql`)
 * didn't know it, unless it's the message's speaker. No recorded cast means everyone except
 * those explicitly absent in this fork. A merge's join: known when the viewer's identities together knew every
 * row of it, or (`partialMerges`) any row. A stretch view (`STRETCH_VIEW`) applies this only in
 * a separate join's parallel stretch (`inStretchSql`) and knew everything else.
 */
export const knowsSql = (
  sql: SqlClient.SqlClient,
  viewers: ReadonlyArray<string>,
  fork?: ForkRef,
  partialMerges = false,
  /** A tool's frozen causal horizon; absent for planning a full fork's summary view. */
  leaf?: string | null
) =>
  Effect.gen(function* () {
    const ids = JSON.stringify(viewers)
    const kept =
      fork === undefined || fork === null
        ? sql`1`
        : sql`NOT EXISTS (SELECT 1 FROM json_each(${ids}) cv WHERE ${correctedAwaySql(sql, fork, "s.id", "cv.value")})`
    const rule = sql`CASE WHEN EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = s.id)
    THEN ${
      partialMerges
        ? sql`EXISTS (
      SELECT 1 FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id=m.id
      WHERE m.slot_id=s.id AND mm.included IN ('verbatim','left_out') AND EXISTS (
        SELECT 1 FROM json_each(coalesce(mm.knowers_json, (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c WHERE c.value ->> 'from' <> 'destination'))) k
        WHERE k.value IN (SELECT value FROM json_each(${ids}))))`
        : sql`NOT EXISTS (
      SELECT 1 FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id=m.id
      WHERE m.slot_id=s.id AND mm.included IN ('verbatim','left_out') AND NOT EXISTS (
        SELECT 1 FROM json_each(coalesce(mm.knowers_json, (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c WHERE c.value ->> 'from' <> 'destination'))) k
        WHERE k.value IN (SELECT value FROM json_each(${ids}))))`
    } AND ${kept}
    ELSE EXISTS (SELECT 1 FROM json_each(${ids}) viewer WHERE viewer.value = v.speaker_entity_id)
      OR ((v.cast_json IS NULL OR EXISTS (SELECT 1 FROM json_each(v.cast_json) c WHERE c.value IN (SELECT value FROM json_each(${ids}))
        AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(v.presence_json, '{}'), '$.away') a
          WHERE a.value = c.value))) AND ${kept}) END`
    return viewers.includes(STRETCH_VIEW)
      ? sql`(NOT ${stretchedSql(sql, yield* threadStretches(sql, fork ?? null, leaf))} OR ${rule})`
      : rule
  })

/**
 * Each version's knowers, in the order asked; null: known to everyone (or not found); and
 * `stretched` for a message in a separate join's parallel stretch (`inStretchSql`). Point
 * lookups by version id: the requested ids drive the query, never a scan of the chat. In fork
 * `fork` (when given), the cards it counts not present for a message are left out of its
 * knowers, its speaker apart (`knowsSql`'s rule). The existing query projects corrected cards
 * by slot, skipping the projection when the chat has no corrections.
 */
export const readKnowers = (
  sql: SqlClient.SqlClient,
  chatId: string,
  owned: Fragment,
  versionIds: ReadonlyArray<string>,
  viewers?: ReadonlyArray<string> | null,
  fork?: ForkRef,
  ranges?: ReadonlyArray<{ readonly chain: string; readonly lo: number; readonly hi: number }>
) =>
  Effect.gen(function* () {
    const stretches = ranges ?? (viewers?.includes(STRETCH_VIEW) ? yield* threadStretches(sql, fork ?? null) : [])
    const rows = yield* sql<{
      id: string
      slot_id: string
      cast_json: string | null
      presence_json: string | null
      speaker_entity_id: string | null
      merge_cast: string | null
      merge_id: string | null
      merge_title: string | null
      content: string
      away_json: string | null
      stretched: number
    }>`SELECT metadata.id, ${stretchedSql(sql, stretches)} AS stretched, metadata.slot_id, ${viewers == null ? sql`''` : sql`payload.content`} AS content,
        ${
          fork == null
            ? sql`NULL`
            : sql`CASE WHEN EXISTS (SELECT 1 FROM fork_overrides WHERE chat_id = ${chatId} AND kind = 'presence_away') THEN
          (SELECT json_group_array(c.card) FROM (
            SELECT DISTINCT substr(o.target_id, length(o.slot_id) + 2) AS card
            FROM fork_overrides o WHERE o.slot_id = metadata.slot_id AND o.kind = 'presence_away'
          ) c WHERE c.card IS NOT metadata.speaker_entity_id
            AND ${correctedAwaySql(sql, fork, "metadata.slot_id", "c.card")}) END`
        } AS away_json,
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
    return versionIds.map((versionId) => {
      const row = byId.get(versionId)
      const all = row === undefined ? null : recorded.get(versionId)!
      const absent = row?.away_json ? (JSON.parse(row.away_json) as Array<string>) : []
      const away = absent.length > 0 ? absent : undefined
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
        ...(row?.stretched ? { stretched: true } : {}),
        ...(view ? { content: view.content, readable: view.rows.length > 0 || !view.partial } : {})
      }
    })
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
