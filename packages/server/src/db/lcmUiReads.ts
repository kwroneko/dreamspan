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
import { insertedOnPath, pathView } from "./lcmDisplay.ts"
import { positionOf, type PathPiece } from "./displayPath.ts"
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
      const shown = yield* pathView(sql, chatId, leaf)
      const rows = yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id) AS (
      SELECT ${leaf} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id=s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id,s.created_at FROM ${shown ? sql`(SELECT id FROM path UNION SELECT value FROM json_each(${insertedOnPath(shown)})) path` : sql`path`}
      JOIN summaries s ON s.last_slot_id=path.id
      WHERE s.chat_id=${chatId} AND s.sealed=1 AND s.status IN ('complete','truncated')`
      const memo = new Map<string, Summary>(),
        valid = lineageValidator(sql, userId, shown ?? undefined)
      const ranges: Array<Summary & { createdAt: number }> = []
      for (const row of rows)
        if (yield* valid(row.id)) {
          const s = yield* readSummary(sql, userId, row.id, undefined, memo, shown ?? undefined)
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

  /**
   * GetLcmCoverage's rows in a fork that shows inserted slots: the summaries ending on its
   * display path at or after position `from` and starting at or before `to`. The structural walk
   * stops at the depth `from` less the fork's insertions, below which no slot reaches `from`.
   */
  const coverageInDisplay = (
    userId: UserId,
    chatId: string,
    leaf: string,
    shown: { readonly pieces: ReadonlyArray<PathPiece>; readonly end: number; readonly fork: string | null },
    from: number,
    to: number
  ) =>
    Effect.gen(function* () {
      const inserted = JSON.parse(insertedOnPath(shown)) as Array<string>
      const floor = from - inserted.length
      const rows = yield* sql<{
        id: string
        created_at: number
        first_chain: string
        first_depth: number
        first_slot_id: string
        last_chain: string
        last_depth: number
        last_slot_id: string
        level: number
      }>`
        WITH RECURSIVE path(id, depth) AS (
          SELECT id, depth FROM slots WHERE id = ${leaf}
          UNION ALL SELECT s.id, s.depth FROM slots s JOIN path p ON s.id = (SELECT parent_slot_id FROM slots WHERE id = p.id)
            WHERE s.depth >= ${floor}
        ), shown(id) AS (SELECT id FROM path UNION SELECT value FROM json_each(${JSON.stringify(inserted)}))
        SELECT s.id, s.created_at, s.level, s.first_slot_id, s.last_slot_id, first.chain_id AS first_chain, first.depth AS first_depth,
          last.chain_id AS last_chain, last.depth AS last_depth
        FROM shown JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = shown.id
          JOIN slots first ON first.id = s.first_slot_id JOIN slots last ON last.id = s.last_slot_id
        WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status <> 'superseded'
          AND ${effectiveOverride(sql, "summary_superseded", shown.fork, "s.id")} IS NULL`
      return rows
        .map((r) => ({
          ...r,
          start: positionOf(shown.pieces, { id: r.first_slot_id, chainId: r.first_chain, depth: r.first_depth }),
          end: positionOf(shown.pieces, { id: r.last_slot_id, chainId: r.last_chain, depth: r.last_depth })
        }))
        .filter((r) => r.start !== null && r.end !== null && r.end >= from && r.end <= shown.end && r.start <= to)
        .sort((a, b) => a.level - b.level || a.start! - b.start!)
        .slice(0, MAX_COVERAGE)
        .map((r) => ({ id: r.id, created_at: r.created_at }))
    })

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
        // In a fork that shows inserted slots, numbers are positions on its display path (spec/MESSAGE-INSERT.md §3.4).
        const shown = yield* pathView(sql, chatId, leafSlotId)

        // Failures and unfinished work: a handful of rows per chat, then which are on the path.
        const failedRows = yield* sql<{
          id: string
          last_slot_id: string
          created_at: number
        }>`SELECT id, last_slot_id, created_at FROM summaries
          WHERE chat_id = ${chatId} AND status = 'failed' AND sealed = 1`
        const fork = yield* viewAt(sql, chatId, leafSlotId)
        const rawJobs = yield* sql<{
          id: string
          level: number
          first_slot_id: string
          last_slot_id: string
          status: LcmJob["status"]
          error: string | null
          first_depth: number
          last_depth: number
          first_chain: string
          last_chain: string
          updated_at: number
        }>`SELECT j.updated_at,j.id, j.level, j.first_slot_id, j.last_slot_id, j.status, j.error, a.depth AS first_depth, b.depth AS last_depth,
            a.chain_id AS first_chain, b.chain_id AS last_chain
          FROM summarization_jobs j JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
          WHERE j.chat_id = ${chatId} AND (j.fork_id IS NULL OR j.fork_id=${fork}) AND j.status IN ('pending', 'processing', 'failed')
          ORDER BY a.depth, j.level, j.id`
        // A job's range as positions (zero-based, as depths are): its ends' depths without insertions.
        const jobRows = shown
          ? rawJobs
              .map((j) => ({
                ...j,
                first_depth:
                  positionOf(shown.pieces, { id: j.first_slot_id, chainId: j.first_chain, depth: j.first_depth }) ??
                  j.first_depth,
                last_depth:
                  positionOf(shown.pieces, { id: j.last_slot_id, chainId: j.last_chain, depth: j.last_depth }) ??
                  j.last_depth
              }))
              .sort((a, b) => a.first_depth - b.first_depth || a.level - b.level || a.id.localeCompare(b.id))
          : rawJobs
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
          if (shown) for (const id of JSON.parse(insertedOnPath(shown)) as Array<string>) onPath.add(id)
        }
        const memo = new Map<string, Summary>()
        const allFailed = yield* Effect.forEach(
          failedRows.filter((r) => onPath.has(r.last_slot_id)),
          (r) => readSummary(sql, userId, r.id, undefined, memo, shown ?? undefined)
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
          cursorDepth:
            shown && layer.cursor !== null
              ? ((yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id = ${layer.cursor}`)[0]?.depth ?? -1)
              : layer.cursorDepth,
          cursorSlotId: layer.cursor as LcmState["leafSlotId"] | null,
          cursorPosition: layer.cursorDepth
        })
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("GetLcmState")),

    GetLcmCoverage: ({
      userId,
      chatId,
      forkId,
      leafSlotId,
      fromDepth,
      toDepth,
      fromPosition,
      toPosition,
      includeResolved
    }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const shown = yield* pathView(sql, chatId, leafSlotId)
        const ids = shown
          ? yield* coverageInDisplay(
              userId,
              chatId,
              leafSlotId,
              shown,
              fromPosition ?? fromDepth,
              toPosition ?? toDepth
            )
          : yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id, depth) AS (
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
        const summaries = yield* Effect.forEach(ids, ({ id }) =>
          readSummary(sql, userId, id, undefined, memo, shown ?? undefined)
        )
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
