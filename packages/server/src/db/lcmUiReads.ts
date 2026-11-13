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
import { insertedOnPath, pathView, type LcmView } from "./lcmDisplay.ts"
import { positionOf, type PathPiece } from "./displayPath.ts"
import { toLlmRequest, type LlmRequestRow } from "./providers.ts"
import { readingOnce, readSummary } from "./lcmReads.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"
import { lcmPath } from "./lcmPath.ts"
import { activeRunSummaries } from "../agent/compaction.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { shownIn } from "./forkState.ts"
import {
  audienceIds,
  audienceScope,
  firstUnknownPosition,
  stretchOnPath,
  inputsKnown,
  knownVersions,
  viewerAudience
} from "./lcmAudience.ts"

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

  /** Every view read observes the same boundary as its selected layer, including ids and errors. */
  const forViewer = Effect.fnUntraced(function* (
    summaries: ReadonlyArray<Summary>,
    chatId: string,
    leaf: string,
    identities?: ReadonlyArray<string>
  ) {
    if (identities === undefined) return summaries
    const firstMissed = yield* firstUnknownPosition(sql, chatId, leaf, identities)
    const fork = yield* viewAt(sql, chatId, leaf)
    const kept: Array<Summary> = []
    for (const summary of summaries) {
      if (!summary.audience && firstMissed !== null && summary.to - 1 >= firstMissed) continue
      if (!summary.fresh && !(yield* inputsKnown(sql, summary.id, identities, fork))) continue
      kept.push(summary)
    }
    return kept
  })

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
        ...(s.audience ? { audience: s.audience } : {}),
        children: s.children.map((c) => c.summaryId)
      }))
    })

  const freshRanges = (userId: UserId, chatId: string, leaf: string, identities?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const shown = yield* pathView(sql, chatId, leaf)
      const rows = yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id) AS (
      SELECT ${leaf} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id=s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id,s.created_at FROM ${shown ? sql`(SELECT id FROM path UNION SELECT value FROM json_each(${insertedOnPath(shown)})) path` : sql`path`}
      JOIN summaries s ON s.last_slot_id=path.id
      WHERE s.chat_id=${chatId} AND s.sealed=1 AND s.status IN ('complete','truncated') AND ${audienceScope(sql, "s", identities)}`
      const memo = new Map<string, Summary>(),
        valid = lineageValidator(sql, userId, shown ?? undefined)
      const ranges: Array<Summary & { createdAt: number }> = []
      for (const row of rows)
        if (yield* valid(row.id)) {
          const s = yield* readSummary(sql, userId, row.id, undefined, memo, shown ?? undefined)
          if (s.fresh) ranges.push({ ...s, createdAt: row.created_at })
        }
      const visible = new Set((yield* forViewer(ranges, chatId, leaf, identities)).map((s) => s.id))
      return ranges.filter((s) => visible.has(s.id))
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
    to: number,
    identities?: ReadonlyArray<string>
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
        WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status <> 'superseded' AND ${audienceScope(sql, "s", identities)}
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

  /** A shared last endpoint alone cannot establish membership after insertions. */
  const onViewedPath = Effect.fnUntraced(function* (
    userId: UserId,
    summaries: ReadonlyArray<Summary>,
    view: LcmView | null
  ) {
    const valid = lineageValidator(sql, userId, view ?? undefined)
    const kept: Array<Summary> = []
    for (const summary of summaries)
      if (view?.pieces ? yield* valid(summary.id) : summary.to - summary.from + 1 === summary.slotCount)
        kept.push(summary)
    return kept
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
          rollout_id: string | null
        }>`SELECT id, origin, token_count, content, created_at, rollout_id FROM summary_revisions WHERE summary_id = ${summaryId} OR summary_id IN (
          SELECT result_summary_id FROM summarization_jobs WHERE source_summary_id=${summaryId} AND status='complete'
        ) ORDER BY seq`
        const requests = rows.some((r) => r.rollout_id !== null)
          ? yield* sql<LlmRequestRow & { rollout_id: string }>`SELECT * FROM llm_requests WHERE owner_user_id=${userId}
              AND rollout_id IN (SELECT value FROM json_each(${JSON.stringify(rows.flatMap((r) => (r.rollout_id ? [r.rollout_id] : [])))})) ORDER BY started_at,id`
          : []
        return rows.map((r, n) => ({
          id: r.id as never,
          number: n + 1,
          origin: r.origin,
          tokens: r.token_count,
          content: r.content,
          createdAt: r.created_at,
          selected: r.id === head.revisionId,
          rolloutId: r.rollout_id,
          requests: requests.filter((q) => q.rollout_id === r.rollout_id).map(toLlmRequest)
        }))
      }).pipe(inSummaryFork(sql, userId, summaryId, forkId), query("ListSummaryRevisions")),

    GetLcmState: ({ userId, chatId, leafSlotId, forkId, viewer }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        // A character's separate context (unit C7): the shared rows and its own.
        const identities =
          viewer === undefined ? undefined : (yield* viewerAudience(sql, chatId, leafSlotId, viewer)).identities
        const [settings] = yield* sql<{
          enabled: number | null
        }>`SELECT json_extract(value_json, '$.enabled') AS enabled FROM state_events e
          WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' AND ${eventApplies(sql, yield* viewAt(sql, chatId, leafSlotId), "e")} ORDER BY seq DESC LIMIT 1`
        const enabled = settings?.enabled === 1
        // Characters with summaries of their own in a shared context (spec/THREADS.md §7.3).
        const stretchViews = (yield* stretchOnPath(sql, chatId, leafSlotId)) ? { stretchViews: true } : {}
        if (!enabled)
          return new LcmState({
            chatId,
            leafSlotId,
            enabled,
            layer: [],
            failed: [],
            jobs: [],
            cursorDepth: -1,
            ...stretchViews
          })
        const layer = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId, false, identities && { identities })
        // In a fork that shows inserted slots, numbers are positions on its display path (spec/MESSAGE-INSERT.md §3.4).
        const shown = yield* pathView(sql, chatId, leafSlotId)

        // Failures and unfinished work: a handful of rows per chat, then which are on the path.
        const failedRows = yield* sql<{
          id: string
          last_slot_id: string
          created_at: number
        }>`SELECT s.id, s.last_slot_id, s.created_at FROM summaries s
          WHERE s.chat_id = ${chatId} AND s.status = 'failed' AND s.sealed = 1 AND ${audienceScope(sql, "s", identities)}`
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
          audience_json: string | null
          rollout_id: string | null
          result_summary_id: string | null
        }>`SELECT j.rollout_id,j.result_summary_id,j.updated_at,j.audience_json,j.id, j.level, j.first_slot_id, j.last_slot_id, j.status, j.error, a.depth AS first_depth, b.depth AS last_depth,
            a.chain_id AS first_chain, b.chain_id AS last_chain
          FROM summarization_jobs j JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
          WHERE j.chat_id = ${chatId} AND (j.fork_id IS NULL OR j.fork_id=${fork}) AND j.status IN ('pending', 'processing', 'failed')
            AND ${audienceScope(sql, "j", identities)}
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
        const pathFailed = yield* onViewedPath(
          userId,
          yield* Effect.forEach(
            failedRows.filter((r) => onPath.has(r.last_slot_id)),
            (r) => readSummary(sql, userId, r.id, undefined, memo, shown ?? undefined)
          ),
          shown
        )
        const allFailed = yield* forViewer(pathFailed, chatId, leafSlotId, identities)
        const firstMissed =
          identities === undefined ? null : yield* firstUnknownPosition(sql, chatId, leafSlotId, identities)
        const visibleJobs: Array<(typeof jobRows)[number]> = []
        for (const job of jobRows) {
          if (job.audience_json === null && firstMissed !== null && job.last_depth >= firstMissed) continue
          if (identities !== undefined) {
            if (job.result_summary_id && !(yield* inputsKnown(sql, job.result_summary_id, identities, fork))) continue
            if (job.rollout_id) {
              const [payload] = yield* sql<{
                context_snapshot_json: string | null
              }>`SELECT context_snapshot_json FROM rollout_payloads WHERE rollout_id=${job.rollout_id}`
              const snapshot = payload?.context_snapshot_json
                ? (JSON.parse(payload.context_snapshot_json) as import("../assembler/types.ts").ContextSnapshot)
                : undefined
              const ids =
                snapshot?.summaryJob?.inputs.flatMap((input) => (input.versionId ? [input.versionId] : [])) ?? []
              const known = yield* knownVersions(sql, ids, identities, fork)
              if (ids.some((id) => !known.has(id))) continue
              let childrenKnown = true
              for (const child of snapshot?.summaryJob?.children ?? [])
                if (!(yield* inputsKnown(sql, child.summaryId, identities, fork))) childrenKnown = false

              if (!childrenKnown) continue
            }
          }
          visibleJobs.push(job)
        }
        const fresh =
          allFailed.length || visibleJobs.some((j) => j.status === "failed")
            ? yield* freshRanges(userId, chatId, leafSlotId, identities)
            : []
        const failed = allFailed.filter(
          (s) => !resolved(s.from, s.to, fresh, { time: failedRows.find((r) => r.id === s.id)!.created_at, id: s.id })
        )
        const jobIds = visibleJobs.filter(
          (r) =>
            onPath.has(r.last_slot_id) &&
            (r.status !== "failed" ||
              !resolved(r.first_depth + 1, r.last_depth + 1, fresh, { time: r.updated_at, id: r.id }))
        )
        const reruns = new Set((yield* rerunRequests(sql, chatId)).map((r) => r.job_id))
        const [kind] = yield* sql<{ kind: string }>`SELECT kind FROM chats WHERE id=${chatId}`
        let runSummaries: Array<{ id: string; from: number; through: number; content: string }> | undefined
        if (identities === undefined && chatKinds.get(kind?.kind ?? "")?.summaryTranscript) {
          const path = yield* lcmPath(sql, userId, chatId, leafSlotId)
          const fork = yield* viewAt(sql, chatId, leafSlotId)
          const [latest] = yield* sql<{ transcript: string | null }>`SELECT p.transcript_json AS transcript
            FROM json_each(${JSON.stringify(path.map((s) => s.id))}) requested CROSS JOIN slots s ON s.id=requested.value
            JOIN versions v ON v.id=${shownIn(sql, fork, "s")} JOIN rollout_payloads p ON p.rollout_id=v.rollout_id
            ORDER BY CAST(requested.key AS INTEGER) DESC LIMIT 1`
          runSummaries = latest?.transcript
            ? activeRunSummaries(JSON.parse(latest.transcript) as Array<AgentMessage>).map(
                ({ id, from, through, content }) => ({ id, from, through, content })
              )
            : []
        }
        return new LcmState({
          chatId,
          leafSlotId,
          enabled,
          layer: yield* toRows(layer.summaries, true),
          ...(runSummaries ? { runSummaries } : {}),
          failed: yield* toRows(failed, true),
          jobs: jobIds.map((j): LcmJob => ({
            id: j.id,
            level: j.level,
            from: j.first_depth + 1,
            to: j.last_depth + 1,
            firstSlotId: j.first_slot_id as never,
            status: j.status,
            error: j.error,
            rerun: reruns.has(j.id),
            ...(j.audience_json === null ? {} : { audience: audienceIds(j.audience_json) })
          })),
          cursorDepth:
            shown && layer.cursor !== null
              ? ((yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id = ${layer.cursor}`)[0]?.depth ?? -1)
              : layer.cursorDepth,
          cursorSlotId: layer.cursor as LcmState["leafSlotId"] | null,
          cursorPosition: layer.cursorDepth,
          ...stretchViews
        })
      }).pipe(readingOnce, inFork(sql, chatId, forkId, leafSlotId), query("GetLcmState")),

    GetLcmCoverage: ({
      userId,
      chatId,
      forkId,
      leafSlotId,
      fromDepth,
      toDepth,
      fromPosition,
      toPosition,
      includeResolved,
      viewer
    }) =>
      Effect.gen(function* () {
        yield* owned(sql, userId, chatId, leafSlotId)
        const identities =
          viewer === undefined ? undefined : (yield* viewerAudience(sql, chatId, leafSlotId, viewer)).identities
        const shown = yield* pathView(sql, chatId, leafSlotId)
        const ids = shown
          ? yield* coverageInDisplay(
              userId,
              chatId,
              leafSlotId,
              shown,
              fromPosition ?? fromDepth,
              toPosition ?? toDepth,
              identities
            )
          : yield* sql<{ id: string; created_at: number }>`WITH RECURSIVE path(id, depth) AS (
            SELECT id, depth FROM slots WHERE id = ${leafSlotId}
            UNION ALL SELECT s.id, s.depth FROM slots s JOIN path p ON s.id = (SELECT parent_slot_id FROM slots WHERE id = p.id)
              WHERE s.depth >= ${fromDepth}
          ) SELECT s.id,s.created_at FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
            JOIN slots first ON first.id = s.first_slot_id
            WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status <> 'superseded' AND ${audienceScope(sql, "s", identities)}
              AND ${effectiveOverride(sql, "summary_superseded", yield* viewAt(sql, chatId, leafSlotId), "s.id")} IS NULL
              AND path.depth >= ${fromDepth} AND first.depth <= ${toDepth}
            ORDER BY s.level, first.depth LIMIT ${MAX_COVERAGE}`
        const memo = new Map<string, Summary>()
        const pathSummaries = yield* onViewedPath(
          userId,
          yield* Effect.forEach(ids, ({ id }) => readSummary(sql, userId, id, undefined, memo, shown ?? undefined)),
          shown
        )
        const summaries = yield* forViewer(pathSummaries, chatId, leafSlotId, identities)
        const fresh = summaries.some((s) => s.status === "failed")
          ? yield* freshRanges(userId, chatId, leafSlotId, identities)
          : []
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
