// What the summary UI reads (ARCHITECTURE §16): the layer in use with the failures and
// unfinished work on the path, a window of coverage for the rail, and a summary's revisions.
import type { UserId } from "@rp/shared/domain.ts"
import type { LcmJob, LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { LcmCoverage, LcmState } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { readSummary } from "./lcmReads.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

/** Most summaries one coverage read returns: far more than a window of 500 messages needs. */
const MAX_COVERAGE = 600

/** The layer is only meaningful for a chat the user owns, with a leaf in it. */
const owned = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, leafSlotId: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql`SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${leafSlotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    if (!row) return yield* new NotFound({ entity: "chat path", id: leafSlotId })
  })

export const makeLcmUiReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  /** Revision counts and rerun requests for some summaries, in one query each. */
  const extras = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const counts = new Map<string, number>()
      const reruns = new Set<string>()
      if (ids.length === 0) return { counts, reruns }
      const marks = ids.map(() => "?").join(",")
      for (const row of yield* sql.unsafe<{ id: string; n: number }>(
        `SELECT summary_id AS id, count(*) AS n FROM summary_revisions WHERE summary_id IN (${marks}) GROUP BY summary_id`,
        ids
      ))
        counts.set(row.id, row.n)
      for (const row of yield* sql.unsafe<{ id: string }>(
        `SELECT summary_id AS id FROM summary_reruns WHERE summary_id IN (${marks})`,
        ids
      ))
        reruns.add(row.id)
      return { counts, reruns }
    })

  const toRows = (summaries: ReadonlyArray<Summary>, withContent: boolean) =>
    Effect.gen(function* () {
      const { counts, reruns } = yield* extras(summaries.map((s) => s.id))
      return summaries.map((s): LcmSummary => ({
        id: s.id,
        level: s.level,
        firstSlotId: s.firstSlotId,
        lastSlotId: s.lastSlotId,
        from: s.from,
        to: s.to,
        slotCount: s.slotCount,
        status: s.status,
        error: s.error,
        fresh: s.fresh,
        tokens: s.tokens,
        origin: s.origin,
        revisionNumber: s.revisionNumber,
        revisionCount: counts.get(s.id) ?? s.revisionNumber,
        rowVersion: s.rowVersion,
        revisionId: s.revisionId,
        rerun: reruns.has(s.id),
        content: withContent ? s.content : null,
        children: s.children.map((c) => c.summaryId)
      }))
    })

  return {
    ListSummaryRevisions: ({ userId, summaryId }) =>
      Effect.gen(function* () {
        const [head] = yield* sql<{
          selected: string
        }>`SELECT s.selected_revision_id AS selected FROM summaries s JOIN chats c ON c.id = s.chat_id
          WHERE s.id = ${summaryId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!head) return yield* new NotFound({ entity: "summary", id: summaryId })
        const rows = yield* sql<{
          id: string
          origin: "generated" | "user" | "changeset" | "imported"
          token_count: number
          content: string
          created_at: number
        }>`SELECT id, origin, token_count, content, created_at FROM summary_revisions WHERE summary_id = ${summaryId} ORDER BY seq`
        return rows.map((r, n) => ({
          id: r.id as never,
          number: n + 1,
          origin: r.origin,
          tokens: r.token_count,
          content: r.content,
          createdAt: r.created_at,
          selected: r.id === head.selected
        }))
      }).pipe(query("ListSummaryRevisions")),

    GetLcmState: ({ userId, chatId, leafSlotId }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const [settings] = yield* sql<{
          enabled: number | null
        }>`SELECT json_extract(value_json, '$.enabled') AS enabled FROM state_events
          WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' ORDER BY seq DESC LIMIT 1`
        const enabled = settings?.enabled === 1
        if (!enabled)
          return new LcmState({ chatId, leafSlotId, enabled, layer: [], failed: [], jobs: [], cursorDepth: -1 })
        const layer = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId)

        // Failures and unfinished work: a handful of rows per chat, then which are on the path.
        const failedRows = yield* sql<{ id: string; last_slot_id: string }>`SELECT id, last_slot_id FROM summaries
          WHERE chat_id = ${chatId} AND status = 'failed' AND sealed = 1`
        const jobRows = yield* sql<{
          id: string
          level: number
          first_slot_id: string
          last_slot_id: string
          status: LcmJob["status"]
          error: string | null
          first_depth: number
          last_depth: number
        }>`SELECT j.id, j.level, j.first_slot_id, j.last_slot_id, j.status, j.error, a.depth AS first_depth, b.depth AS last_depth
          FROM summarization_jobs j JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
          WHERE j.chat_id = ${chatId} AND j.status IN ('pending', 'processing', 'failed')
          ORDER BY a.depth, j.level, j.id`
        const candidates = [
          ...new Set([...failedRows.map((r) => r.last_slot_id), ...jobRows.map((r) => r.last_slot_id)])
        ]
        const onPath = new Set<string>()
        if (candidates.length > 0) {
          const marks = candidates.map(() => "?").join(",")
          const found = yield* sql.unsafe<{ id: string }>(
            `WITH RECURSIVE path(id) AS (
               SELECT ? UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
             ) SELECT id FROM path WHERE id IN (${marks})`,
            [leafSlotId, ...candidates]
          )
          for (const row of found) onPath.add(row.id)
        }
        const memo = new Map<string, Summary>()
        const failed = yield* Effect.forEach(
          failedRows.filter((r) => onPath.has(r.last_slot_id)),
          (r) => readSummary(sql, userId, r.id, undefined, memo)
        )
        const jobIds = jobRows.filter((r) => onPath.has(r.last_slot_id))
        const { reruns } = yield* Effect.gen(function* () {
          const found = new Set<string>()
          if (jobIds.length > 0) {
            const marks = jobIds.map(() => "?").join(",")
            for (const row of yield* sql.unsafe<{ id: string }>(
              `SELECT job_id AS id FROM summary_reruns WHERE job_id IN (${marks})`,
              jobIds.map((j) => j.id)
            ))
              found.add(row.id)
          }
          return { reruns: found }
        })
        return new LcmState({
          chatId,
          leafSlotId,
          enabled,
          layer: yield* toRows(layer.summaries, true),
          failed: yield* toRows(failed, true),
          jobs: jobIds.map((j): LcmJob => ({
            id: j.id,
            level: j.level,
            from: j.first_depth + 1,
            to: j.last_depth + 1,
            firstSlotId: j.first_slot_id as never,
            status: j.status,
            error: j.error,
            rerun: reruns.has(j.id)
          })),
          cursorDepth: layer.cursorDepth
        })
      }).pipe(query("GetLcmState")),

    GetLcmCoverage: ({ userId, chatId, leafSlotId, fromDepth, toDepth }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const ids = yield* sql<{ id: string }>`WITH RECURSIVE path(id, depth) AS (
            SELECT id, depth FROM slots WHERE id = ${leafSlotId}
            UNION ALL SELECT s.id, s.depth FROM slots s JOIN path p ON s.id = (SELECT parent_slot_id FROM slots WHERE id = p.id)
              WHERE s.depth >= ${fromDepth}
          ) SELECT s.id FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
            JOIN slots first ON first.id = s.first_slot_id
            WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status <> 'superseded'
              AND path.depth >= ${fromDepth} AND first.depth <= ${toDepth}
            ORDER BY s.level, first.depth LIMIT ${MAX_COVERAGE}`
        const memo = new Map<string, Summary>()
        const summaries = yield* Effect.forEach(ids, ({ id }) => readSummary(sql, userId, id, undefined, memo))
        return new LcmCoverage({ leafSlotId, summaries: yield* toRows(summaries, false) })
      }).pipe(query("GetLcmCoverage"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
