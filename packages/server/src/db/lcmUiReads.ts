import { inSummaryFork, rerunRequests, summaryChoices } from "./lcmFork.ts"
import { effectiveOverride, eventApplies, inFork, viewAt } from "./forkState.ts"
// What the summary UI reads (ARCHITECTURE §16): the layer in use with the failures and
// unfinished work on the path, a window of coverage for the rail, and a summary's revisions.
import type { UserId } from "@rp/shared/domain.ts"
import type { LcmJob, LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { LcmCoverage, LcmState } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { lineageValidator, selectSummaryLayer } from "./lcmLayer.ts"
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
  const extras = (ids: ReadonlyArray<string>, chatId: string) =>
    Effect.gen(function* () {
      const counts = new Map<string, number>()
      const reruns = new Set<string>()
      const replacements = new Set<string>()
      if (ids.length === 0) return { counts, reruns, replacements }
      const marks = ids.map(() => "?").join(",")
      for (const row of yield* sql.unsafe<{ id: string; n: number }>(
        `SELECT summary_id AS id, count(*) AS n FROM summary_revisions WHERE summary_id IN (${marks}) GROUP BY summary_id`,
        ids
      ))
        counts.set(row.id, row.n)
      for (const row of yield* rerunRequests(sql, chatId))
        if (row.summary_id && ids.includes(row.summary_id)) reruns.add(row.summary_id)
      for (const row of yield* sql.unsafe<{ id: string; n: number }>(
        `SELECT j.source_summary_id AS id,count(r.id) AS n FROM summarization_jobs j
          JOIN summaries s ON s.id=j.result_summary_id JOIN summary_revisions r ON r.summary_id=s.id
          WHERE j.source_summary_id IN (${marks}) AND j.status='complete' GROUP BY j.source_summary_id`,
        ids
      )) {
        replacements.add(row.id)
        counts.set(row.id, (counts.get(row.id) ?? 0) + row.n)
      }
      return { counts, reruns, replacements }
    })

  const toRows = (summaries: ReadonlyArray<Summary>, withContent: boolean) =>
    Effect.gen(function* () {
      const { counts, reruns, replacements } = yield* extras(
        summaries.map((s) => s.id),
        summaries[0]?.chatId ?? ""
      )
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
        replacementAvailable: replacements.has(s.id),
        content: withContent ? s.content : null,
        children: s.children.map((c) => c.summaryId)
      }))
    })

  const freshRanges = (userId: UserId, chatId: string, leaf: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id) AS (
      SELECT ${leaf} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id=s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id,s.created_at FROM path JOIN summaries s ON s.last_slot_id=path.id
      WHERE s.chat_id=${chatId} AND s.sealed=1 AND s.status IN ('complete','truncated')`
      const memo = new Map<string, Summary>(),
        valid = lineageValidator(sql, userId)
      const ranges: Array<Summary & { createdAt: number }> = []
      for (const row of rows)
        if (yield* valid(row.id)) {
          const s = yield* readSummary(sql, userId, row.id, undefined, memo)
          if (s.fresh) ranges.push({ ...s, createdAt: row.created_at })
        }
      return ranges
    })
  const resolved = (
    from: number,
    to: number,
    ranges: ReadonlyArray<Summary & { createdAt: number }>,
    after: { time: number; id: string }
  ) => {
    let start = from
    for (const s of ranges
      .filter((s) => s.createdAt > after.time || (s.createdAt === after.time && s.id > after.id))
      .sort((a, b) => a.from - b.from)) {
      if (s.from > start) break
      if (s.to >= start) start = s.to + 1
      if (start > to) return true
    }
    return false
  }

  return {
    ListSummaryRevisions: ({ userId, summaryId, forkId }) =>
      Effect.gen(function* () {
        const initial = yield* readSummary(sql, userId, summaryId)
        const choices = new Map((yield* summaryChoices(sql, initial.chatId)).map((c) => [c.summary_id, c.chosen_id]))
        let id: string = summaryId
        const seen = new Set<string>()
        while (choices.has(id) && choices.get(id) !== id && !seen.has(id)) {
          seen.add(id)
          id = choices.get(id)!
        }
        const head = yield* readSummary(sql, userId, id)
        const rows = yield* sql<{
          id: string
          origin: "generated" | "user" | "changeset" | "imported"
          token_count: number
          content: string
          created_at: number
        }>`SELECT id, origin, token_count, content, created_at FROM summary_revisions WHERE summary_id = ${summaryId} OR summary_id IN (
          SELECT result_summary_id FROM summarization_jobs WHERE source_summary_id=${summaryId} AND status='complete'
        ) ORDER BY seq`
        return rows.map((r, n) => ({
          id: r.id as never,
          number: n + 1,
          origin: r.origin,
          tokens: r.token_count,
          content: r.content,
          createdAt: r.created_at,
          selected: r.id === head.revisionId
        }))
      }).pipe(inSummaryFork(sql, userId, summaryId, forkId), query("ListSummaryRevisions")),

    GetLcmState: ({ userId, chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const [settings] = yield* sql<{
          enabled: number | null
        }>`SELECT json_extract(value_json, '$.enabled') AS enabled FROM state_events e
          WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' AND ${eventApplies(sql, yield* viewAt(sql, chatId, leafSlotId), "e")} ORDER BY seq DESC LIMIT 1`
        const enabled = settings?.enabled === 1
        if (!enabled)
          return new LcmState({ chatId, leafSlotId, enabled, layer: [], failed: [], jobs: [], cursorDepth: -1 })
        const layer = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId)

        // Failures and unfinished work: a handful of rows per chat, then which are on the path.
        const failedRows = yield* sql<{
          id: string
          last_slot_id: string
          created_at: number
        }>`SELECT id, last_slot_id, created_at FROM summaries
          WHERE chat_id = ${chatId} AND status = 'failed' AND sealed = 1`
        const fork = yield* viewAt(sql, chatId, leafSlotId)
        const jobRows = yield* sql<{
          id: string
          level: number
          first_slot_id: string
          last_slot_id: string
          status: LcmJob["status"]
          error: string | null
          first_depth: number
          last_depth: number
          updated_at: number
        }>`SELECT j.updated_at,j.id, j.level, j.first_slot_id, j.last_slot_id, j.status, j.error, a.depth AS first_depth, b.depth AS last_depth
          FROM summarization_jobs j JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
          WHERE j.chat_id = ${chatId} AND (j.fork_id IS NULL OR j.fork_id=${fork}) AND j.status IN ('pending', 'processing', 'failed')
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
        const allFailed = yield* Effect.forEach(
          failedRows.filter((r) => onPath.has(r.last_slot_id)),
          (r) => readSummary(sql, userId, r.id, undefined, memo)
        )
        const fresh =
          allFailed.length || jobRows.some((j) => j.status === "failed")
            ? yield* freshRanges(userId, chatId, leafSlotId)
            : []
        const failed = allFailed.filter(
          (s) => !resolved(s.from, s.to, fresh, { time: failedRows.find((r) => r.id === s.id)!.created_at, id: s.id })
        )
        const jobIds = jobRows.filter(
          (r) =>
            onPath.has(r.last_slot_id) &&
            (r.status !== "failed" ||
              !resolved(r.first_depth + 1, r.last_depth + 1, fresh, { time: r.updated_at, id: r.id }))
        )
        const reruns = new Set((yield* rerunRequests(sql, chatId)).map((r) => r.job_id))
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
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("GetLcmState")),

    GetLcmCoverage: ({ userId, chatId, forkId, leafSlotId, fromDepth, toDepth, includeResolved }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const ids = yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id, depth) AS (
            SELECT id, depth FROM slots WHERE id = ${leafSlotId}
            UNION ALL SELECT s.id, s.depth FROM slots s JOIN path p ON s.id = (SELECT parent_slot_id FROM slots WHERE id = p.id)
              WHERE s.depth >= ${fromDepth}
          ) SELECT s.id,s.created_at FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
            JOIN slots first ON first.id = s.first_slot_id
            WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status <> 'superseded'
              AND ${effectiveOverride(sql, "summary_superseded", yield* viewAt(sql, chatId, leafSlotId), "s.id")} IS NULL
              AND path.depth >= ${fromDepth} AND first.depth <= ${toDepth}
            ORDER BY s.level, first.depth LIMIT ${MAX_COVERAGE}`
        const memo = new Map<string, Summary>()
        const summaries = yield* Effect.forEach(ids, ({ id }) => readSummary(sql, userId, id, undefined, memo))
        const fresh = summaries.some((s) => s.status === "failed") ? yield* freshRanges(userId, chatId, leafSlotId) : []
        const rows = yield* toRows(
          summaries.filter((s) => s.status !== "superseded"),
          false
        )
        return new LcmCoverage({
          leafSlotId,
          summaries: rows
            .map((s) => ({
              ...s,
              resolved:
                s.status === "failed" &&
                resolved(s.from, s.to, fresh, { time: ids.find((r) => r.id === s.id)!.created_at, id: s.id })
            }))
            .filter((s) => includeResolved || !s.resolved)
        })
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("GetLcmCoverage"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
