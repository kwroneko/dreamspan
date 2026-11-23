// What lies between the summarized part (or the chat's start) and the next request's history
// start, for the timeline's boundary lines (ARCHITECTURE §12 "Context membership"): the last
// message the budget left out, if any, and whether messages hidden from the model come before
// the first message sent. Read from the history windows the assembler read (its pins), so it
// costs one indexed lookup of the hidden candidates' visibility and no path walk.
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot, SourcePins } from "../assembler/types.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"

interface HistoryGap {
  /** The position of the last message the budget left out; null: the budget left none out. */
  readonly cutThrough: number | null
  /**
   * The position of the first message the request sends when messages hidden from the model
   * come before it, with nothing the budget left out in between; null otherwise.
   */
  readonly hiddenBefore: number | null
}

/**
 * The gap before `start` (a display position) on the path the history windows in `pins` read.
 * `through`: the last summarized position (-1: none). When the read stopped once the budget was
 * full, the rest of the path above it is counted by a walk up its parents (structural depths).
 */
export const historyGap = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: string | null,
  pins: Pick<SourcePins, "history">,
  start: number,
  through: number
) =>
  Effect.gen(function* () {
    const seen = new Map<string, { readonly depth: number; readonly inContext: boolean }>()
    let reachedTop = false
    let top = Number.POSITIVE_INFINITY
    for (const window of pins.history) {
      for (const entry of window.entries) seen.set(entry.slotId, { depth: entry.depth, inContext: entry.inContext })
      const first = window.entries[0]?.depth ?? Number.POSITIVE_INFINITY
      if (first <= top) {
        top = first
        reachedTop = window.older === null
      }
    }
    const before = [...seen.entries()].filter(([, e]) => e.depth > through && e.depth < start)
    const sent = before.filter(([, e]) => e.inContext)
    const cutThrough = sent.length === 0 ? null : Math.max(...sent.map(([, e]) => e.depth))
    // The first message on the path that would be sent: the start without a cut, else the
    // first one cut, the earliest read when the read reached the top of what isn't summarized.
    const firstSendable = cutThrough === null ? start : Math.min(...sent.map(([, e]) => e.depth))
    const candidates = before.filter(([, e]) => !e.inContext && e.depth < firstSendable).map(([id]) => id)
    let hidden = false
    if (candidates.length > 0) {
      const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots s
        WHERE s.chat_id = ${chatId} AND s.id IN (SELECT value FROM json_each(${JSON.stringify(candidates)}))
          AND ${contextExcludedIn(sql, fork)} = 1`
      hidden = (row?.n ?? 0) > 0
    }
    if (!reachedTop && cutThrough !== null) {
      // The read stopped once the budget was full: what's above the oldest message it read,
      // walked up the path to the summarized part or the root. Its messages are counted, never read.
      const oldest = [...seen.entries()].reduce<[string, number] | null>(
        (best, [id, e]) => (best === null || e.depth < best[1] ? [id, e.depth] : best),
        null
      )
      if (oldest !== null) {
        const [above] = yield* sql<{ sendable: number; hidden: number }>`WITH RECURSIVE up(id, depth) AS (
            SELECT parent_slot_id, depth - 1 FROM slots WHERE id = ${oldest[0]} AND chat_id = ${chatId}
              AND parent_slot_id IS NOT NULL
            UNION ALL
            SELECT s.parent_slot_id, u.depth - 1 FROM slots s JOIN up u ON s.id = u.id
            WHERE s.parent_slot_id IS NOT NULL AND u.depth - 1 > ${through}
          )
          SELECT coalesce(sum(CASE WHEN ${contextExcludedIn(sql, fork)} = 0 AND v.status <> 'failed'
              AND (v.content_length > 0 OR EXISTS (SELECT 1 FROM version_attachments a WHERE a.version_id = v.id))
              THEN 1 ELSE 0 END), 0) AS sendable,
            coalesce(sum(${contextExcludedIn(sql, fork)} = 1), 0) AS hidden
          FROM up JOIN slots s ON s.id = up.id JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}
          WHERE up.depth > ${through} AND NOT ${slotDeletedIn(sql, fork, "s")}`
        // Something above would be sent too: the first message isn't known from here.
        if ((above?.sendable ?? 0) > 0) return { cutThrough, hiddenBefore: null } satisfies HistoryGap
        hidden ||= (above?.hidden ?? 0) > 0
      }
    }
    return { cutThrough, hiddenBefore: hidden ? firstSendable : null } satisfies HistoryGap
  })

/**
 * The titles of the imported ST summary notes (kind `imported_summary`) the request sends, in
 * the order it sends them.
 */
export const sentSummaryNotes = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, next: ContextSnapshot) =>
  Effect.gen(function* () {
    const entities = [
      ...new Set(
        next.pieces.flatMap((piece) =>
          piece.source.kind === "note" && piece.messages.length > 0 && piece.text.trim() !== ""
            ? [piece.source.entity]
            : []
        )
      )
    ]
    if (entities.length === 0) return []
    const rows = yield* sql<{ id: string; title: string | null }>`
      SELECT e.id, json_extract(h.doc_json, '$.title') AS title
      FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
        AND e.id IN (SELECT value FROM json_each(${JSON.stringify(entities)}))
        AND json_extract(h.doc_json, '$.owner.chat') = ${chatId}
        AND json_extract(h.doc_json, '$.kind') = 'imported_summary'`
    const titles = new Map(rows.map((row) => [row.id, row.title?.trim() || "Summary (from ST)"]))
    return [...new Set(entities.flatMap((id) => (titles.has(id) ? [titles.get(id)!] : [])))]
  })
