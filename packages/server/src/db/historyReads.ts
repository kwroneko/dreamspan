import { contextExcludedIn } from "./lcmVisibility.ts"
import { HistoryRejected, type HistoryEdit, type HistoryHit } from "@rp/shared/historyApi.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { shownIn, shownVersionDeletedIn, selectedIn, shownJoin, slotDeletedIn, versionDeletedIn } from "./forkState.ts"
import { historyCurrent, historyFork, historySummaryRevision } from "./historyShared.ts"
import { pathSegments } from "./pathSegments.ts"
import { displayLength, displayPositionSql, displaySlots, pathPieces, placedInsertions } from "./displayPath.ts"
import { scanHistory } from "./historyScan.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { displayEndOf } from "./displayPath.ts"
import { withoutPurged } from "./stateRefs.ts"
import { query } from "./tx.ts"
import type { ReadOps } from "./ops.ts"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"

export const makeHistoryReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  /**
   * The display path of a fork that places insertions (spec/MESSAGE-INSERT.md §3.3); null for
   * any other, which is read by the structural code as before, where positions are depths.
   */
  const displayPieces = (chatId: string, forkId: string, tipSlotId: string | null) =>
    Effect.gen(function* () {
      if ((yield* placedInsertions(sql, chatId, forkId)).length === 0) return null
      return yield* pathPieces(sql, chatId, forkId, tipSlotId)
    })
  return {
    PreviewHistory: ({ userId, chatId, forkId, search, cursor }) =>
      Effect.gen(function* () {
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        // With insertions, the windows, hits and cursor are positions on the display path.
        const pieces = yield* displayPieces(chatId, forkId, fork.tip_slot_id)
        // Validate patterns even when the scope is empty.
        yield* scanHistory([], search)
        const hits: HistoryHit[] = []
        const kinds =
          cursor?.kind === "summary_revision"
            ? (["summary_revision"] as const)
            : (["version_replace", "summary_revision"] as const)
        for (const kind of kinds) {
          if (kind === "version_replace" && !search.messages && !search.swipes) continue
          if (kind === "summary_revision" && !search.summaries) continue
          const afterSeq = cursor?.kind === kind ? cursor.seq : 0
          const fromDepth = cursor?.kind === kind ? (cursor.depth ?? 0) : 0
          const throughDepth = fromDepth + 99
          // FTS is safe only for a complete ASCII word in literal whole-word mode. Include
          // non-ASCII texts too: JS word boundaries and unicode61 token boundaries differ.
          const term =
            !search.regex && search.wholeWord && search.pairs.every((p) => /^[A-Za-z]+$/.test(p.find))
              ? search.pairs.map((p) => '"' + p.find + '"').join(" OR ")
              : null
          type Row = {
            seq: number
            targetId: string
            beforeId: string
            before: string
            slotId: string
            depth: number
            toDepth: number
            selected: number
            level: number
          }
          const versionFilters = sql`AND NOT ${slotDeletedIn(sql, forkId, "s")} AND NOT ${versionDeletedIn(sql, forkId, "o")}
            AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status <> 'generating'
            AND (CASE WHEN o.id=${selectedIn(sql, forkId, "s")} THEN ${search.messages ? 1 : 0} ELSE ${search.swipes ? 1 : 0} END)
            AND (${term} IS NULL OR v.seq IN (SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${term ?? '""'}) OR v.content GLOB '*[^ -~]*')`
          const summaryRows = sql`SELECT r.seq, s.id AS targetId, r.id AS beforeId, r.content AS before, a.id AS slotId,
            ${sql.literal(pieces === null ? "a.depth" : displayPositionSql("a"))} AS depth,
            ${sql.literal(pieces === null ? "b.depth" : displayPositionSql("b"))} AS toDepth, 1 AS selected, s.level
          FROM summaries s JOIN slots a ON a.id=s.first_slot_id JOIN slots b ON b.id=s.last_slot_id
            JOIN summary_revisions r ON r.id=${historySummaryRevision(sql, forkId, "s")}
          WHERE s.chat_id=${chatId} AND s.sealed=1 AND s.status <> 'superseded' AND r.seq>${afterSeq}`
          const summaryTerm = sql`(${term} IS NULL OR r.seq IN (SELECT rowid FROM summary_revisions_fts WHERE summary_revisions_fts MATCH ${term ?? '""'}) OR r.content GLOB '*[^ -~]*')`
          const rows =
            pieces !== null
              ? kind === "version_replace"
                ? // The window's positions, inserted messages included, in display order.
                  yield* sql<Row>`
          ${displaySlots(sql, pieces, fromDepth, throughDepth)}
          SELECT o.seq, o.id AS targetId, v.id AS beforeId, v.content AS before, s.id AS slotId, d.position AS depth, d.position AS toDepth,
            o.id=${selectedIn(sql, forkId, "s")} AS selected, 0 AS level
          FROM display_slots d JOIN slots s ON s.id=d.id AND s.chat_id=${chatId}
          JOIN versions o ON o.slot_id=s.id AND o.fork_id IS NULL ${shownJoin(sql, forkId)}
          WHERE (d.position>${fromDepth} OR o.seq>${afterSeq}) ${versionFilters}
          ORDER BY d.position, o.seq LIMIT 101`
                : // A summary is in the fork's history when its first and last messages are shown.
                  yield* sql<Row>`
          ${displaySlots(sql, pieces, 0, displayLength(pieces) - 1)}
          SELECT * FROM (${summaryRows} AND ${summaryTerm}) WHERE depth IS NOT NULL AND toDepth IS NOT NULL
          ORDER BY seq LIMIT 101`
              : kind === "version_replace"
                ? yield* sql<Row>`
          ${pathSegments(sql, chatId, fork.tip_slot_id, null)}
          SELECT o.seq, o.id AS targetId, v.id AS beforeId, v.content AS before, s.id AS slotId, s.depth, s.depth AS toDepth,
            o.id=${selectedIn(sql, forkId, "s")} AS selected, 0 AS level
          FROM segments g CROSS JOIN slots s ON s.chat_id=${chatId} AND s.chain_id=g.chain_id AND s.depth BETWEEN max(g.lo, ${fromDepth}) AND min(g.hi, ${throughDepth})
          JOIN versions o ON o.slot_id=s.id AND o.fork_id IS NULL ${shownJoin(sql, forkId)}
          WHERE (s.depth>${fromDepth} OR o.seq>${afterSeq}) ${versionFilters}
          ORDER BY s.depth, o.seq LIMIT 101`
                : yield* sql<Row>`
          ${pathSegments(sql, chatId, fork.tip_slot_id, null)}
          ${summaryRows}
            AND EXISTS(SELECT 1 FROM segments WHERE chain_id=a.chain_id AND a.depth BETWEEN lo AND hi)
            AND EXISTS(SELECT 1 FROM segments WHERE chain_id=b.chain_id AND b.depth BETWEEN lo AND hi)
            AND ${summaryTerm}
          ORDER BY r.seq LIMIT 101`
          const page = rows.slice(0, 100)
          if (page.some((r) => r.before.length > 2_000_000))
            return yield* new HistoryRejected({ message: "A text is too large. Narrow the search." })
          const results = yield* scanHistory(
            page.map((r) => r.before),
            search
          )
          page.forEach((row, index) => {
            const result = results[index]!
            if (result.matches.length)
              hits.push({ ...row, kind, after: result.after, matches: result.matches, selected: row.selected === 1 })
          })
          if (rows.length > 100)
            return {
              hits,
              next: {
                kind,
                seq: page.at(-1)!.seq,
                ...(kind === "version_replace" ? { depth: page.at(-1)!.depth } : {})
              }
            }
          if (kind === "version_replace" && pieces !== null) {
            if (displayLength(pieces) - 1 > throughDepth)
              return { hits, next: { kind, seq: 0, depth: throughDepth + 1 } }
          } else if (kind === "version_replace") {
            const [tip] = yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id=${fork.tip_slot_id}`
            if (tip && tip.depth > throughDepth) return { hits, next: { kind, seq: 0, depth: throughDepth + 1 } }
          }
        }
        return { hits, next: null }
      }).pipe(query("PreviewHistory")),
    ListHistoryEdits: ({ userId, chatId, forkId }) =>
      Effect.gen(function* () {
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        // Application rows are immutable; flattening a long fork lineage must retain history.
        const rows = yield* sql<{
          id: string
          group_id: string
          title: string
          created_at: number
          fork_id: string
          name: string | null
        }>`
        WITH RECURSIVE ancestry(id, bound) AS (
          SELECT ${forkId}, 9223372036854775807 UNION ALL
          SELECT f.parent_fork_id, min(a.bound, f.branched_at) FROM ancestry a JOIN forks f ON f.id=a.id WHERE f.parent_fork_id IS NOT NULL
        ) SELECT c.*, f.name FROM ancestry a JOIN changesets c ON c.fork_id=a.id AND c.seq<=a.bound
          JOIN forks f ON f.id=c.fork_id WHERE c.chat_id=${chatId} ORDER BY c.created_at DESC, c.id DESC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const raw = yield* sql<{
              id: number
              target_kind: HistoryEdit["kind"]
              target_id: string
              before_json: string
              after_json: string
            }>`SELECT * FROM changeset_items WHERE changeset_id=${row.id} ORDER BY id`
            const items = yield* Effect.forEach(raw, (item) =>
              Effect.gen(function* () {
                const before = JSON.parse(item.before_json) as { id: string; content: string; slotId: string | null }
                const after = JSON.parse(item.after_json) as { id: string; content: string }
                const current = yield* historyCurrent(sql, fork, { kind: item.target_kind, targetId: item.target_id })
                return {
                  id: item.id,
                  kind: item.target_kind,
                  targetId: item.target_id,
                  beforeId: before.id,
                  before: before.content,
                  after: after.content,
                  slotId: before.slotId,
                  applied: current?.id === after.id && current.content === after.content
                }
              })
            )
            const n = items.filter((i) => i.applied).length
            return {
              id: row.id,
              groupId: row.group_id,
              title: row.title,
              createdAt: row.created_at,
              madeIn: row.fork_id,
              madeInName: row.name ?? "Unnamed fork",
              inherited: row.fork_id !== forkId,
              status:
                n === items.length ? ("applied" as const) : n === 0 ? ("undone" as const) : ("partly undone" as const),
              items
            }
          })
        )
      }).pipe(query("ListHistoryEdits")),
    HistoryEditCost: ({ userId, chatId, forkId, fromDepth, retainedDepth, summaryIds }) =>
      Effect.gen(function* () {
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        // With insertions, `fromDepth` and `retainedDepth` are positions on the display path.
        const pieces = yield* displayPieces(chatId, forkId, fork.tip_slot_id)
        const from = Math.max(fromDepth, retainedDepth)
        const [messages] = yield* sql<{ messages: number; tokens: number }>`
        ${pieces === null ? pathSegments(sql, chatId, fork.tip_slot_id, null) : displaySlots(sql, pieces, from, displayLength(pieces) - 1)}
        SELECT count(*) AS messages,coalesce(sum((length(CAST(v.content AS BLOB))+3)/4+4),0) AS tokens
        FROM ${
          pieces === null
            ? sql`segments g CROSS JOIN slots s ON s.chat_id=${chatId} AND s.chain_id=g.chain_id AND s.depth BETWEEN max(g.lo,${from}) AND g.hi`
            : sql`display_slots d JOIN slots s ON s.id=d.id AND s.chat_id=${chatId}`
        }
        JOIN version_records v ON v.id=${shownIn(sql, forkId, "s")} WHERE NOT ${slotDeletedIn(sql, forkId, "s")} AND NOT ${shownVersionDeletedIn(sql, forkId, "v")}
        AND ${contextExcludedIn(sql, forkId)}=0 AND v.status <> 'generating'`
        const [summaries] = yield* sql<{ summaries: number; tokens: number }>`
        SELECT count(*) AS summaries,coalesce(sum(r.token_count),0) AS tokens FROM summaries s JOIN summary_revisions r ON r.id=${historySummaryRevision(sql, forkId, "s")}
        WHERE s.chat_id=${chatId} AND s.id IN (SELECT value FROM json_each(${JSON.stringify(summaryIds)}))`
        return {
          messages: messages!.messages,
          summaries: summaries!.summaries,
          tokens: messages!.tokens + summaries!.tokens
        }
      }).pipe(query("HistoryEditCost")),
    RenameHistoryTargets: ({ userId, entityId }) =>
      Effect.gen(function* () {
        const [card] =
          yield* sql`SELECT id FROM entities WHERE id=${entityId} AND owner_user_id=${userId} AND deleted_at IS NULL AND kind='card'`
        if (!card) return yield* new NotFound({ entity: "card", id: entityId })
        const forks = yield* sql<{ chatId: ChatId; forkId: ForkId; tip: SlotId | null }>`
        SELECT c.id AS chatId, f.id AS forkId, f.tip_slot_id AS tip FROM chats c JOIN forks f ON f.chat_id=c.id
        WHERE c.owner_user_id=${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL AND f.purged_at IS NULL`
        const targets: Array<{ chatId: ChatId; forkId: ForkId }> = []
        for (const fork of forks) {
          // The fork as it stands: through its display end, an inserted message after the tip included.
          const end = yield* displayEndOf(sql, fork.chatId, { id: fork.forkId, tip_slot_id: fork.tip })
          const events = yield* stateEventsThrough(sql, fork.chatId, end as SlotId | null, fork.forkId)
          const parsed = events.map((e) => ({
            scope: e.scope,
            data: { key: e.key, value: JSON.parse(e.value_json) }
          })) as FoldableEvent[]
          const state = foldState(yield* withoutPurged(sql, parsed))
          if (state.participants.includes(entityId)) targets.push({ chatId: fork.chatId, forkId: fork.forkId })
        }
        return targets
      }).pipe(query("RenameHistoryTargets"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
