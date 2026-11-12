import { summaryChoices } from "./lcmFork.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { readSummary, SummaryReads } from "./lcmReads.ts"
import { audienceScope, firstUnknownPosition, inputsKnown } from "./lcmAudience.ts"
import {
  followsInDisplay,
  insertedOnPath,
  pathView,
  placesOf,
  positionIn,
  seamStale,
  type LcmView
} from "./lcmDisplay.ts"
import { Summary as SummaryClass } from "@rp/shared/lcm.ts"

/** A summary as a layer walk sees it at a seam: covering the gap after it (or before it), stale. */
const extend = (s: Summary, change: Partial<Summary>) => new SummaryClass({ ...s, ...change })

/**
 * Recheck stored lineage before freshness recursion or advancing past originals. With a view of
 * a fork that shows inserted slots, a summary's range is a stretch of that fork's display path
 * (spec/MESSAGE-INSERT.md §3.4): its inputs, or its parts, follow one another there in order with
 * only inserted slots between them, which makes it stale, not inconsistent. A summary with an
 * input the fork doesn't show is inconsistent there and ignored.
 */
export const lineageValidator = (sql: SqlClient.SqlClient, userId: UserId, view?: LcmView) => {
  const memo = new Map<string, boolean>()
  const valid = (id: string): Effect.Effect<boolean, import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      if (memo.has(id)) return memo.get(id)!
      // Without inserted slots in view, the check is structural: the same in every fork.
      const kept = view?.pieces ? null : yield* SummaryReads
      const known = kept?.valid.get(id)
      if (known !== undefined) {
        memo.set(id, known)
        return known
      }
      const answer = yield* check(id)
      kept?.valid.set(id, answer)
      return answer
    })
  const check = (id: string): Effect.Effect<boolean, import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      memo.set(id, false)
      const [summary] = yield* sql<{
        chat_id: string
        level: number
        first_slot_id: string
        last_slot_id: string
        slot_count: number
        selected_revision_id: string
      }>`
      SELECT s.* FROM summaries s JOIN chats c ON c.id=s.chat_id
      WHERE s.id=${id} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL AND s.sealed=1
        AND EXISTS(SELECT 1 FROM summary_revisions r WHERE r.id=s.selected_revision_id AND r.summary_id=s.id)`
      if (!summary) return false
      if (view?.pieces) {
        const ok = yield* displayValid({ ...summary, id })
        if (ok) memo.set(id, true)
        return ok
      }
      const chain = yield* sql<{ id: string; parent_slot_id: string | null }>`
      WITH RECURSIVE chain(id,parent_slot_id,n) AS (
        SELECT id,parent_slot_id,1 FROM slots WHERE id=${summary.last_slot_id} AND chat_id=${summary.chat_id}
        UNION ALL SELECT s.id,s.parent_slot_id,c.n+1 FROM slots s JOIN chain c ON s.id=c.parent_slot_id
          WHERE c.n<${summary.slot_count} AND s.chat_id=${summary.chat_id}
      ) SELECT id,parent_slot_id FROM chain ORDER BY n DESC`
      if (chain.length !== summary.slot_count || chain[0]?.id !== summary.first_slot_id) return false
      const inputs = yield* sql<{ ordinal: number; slot_id: string; version_valid: number }>`
      SELECT i.ordinal,i.slot_id,i.version_id IS NULL OR EXISTS(SELECT 1 FROM versions v WHERE v.id=i.version_id AND v.slot_id=i.slot_id) AS version_valid
      FROM summary_inputs i WHERE i.summary_id=${id} ORDER BY i.ordinal`
      const children = yield* sql<{
        ordinal: number
        parent_id: string
        level: number
        first_slot_id: string
        last_slot_id: string
        slot_count: number
        chat_id: string
        status: string
        revision_valid: number
      }>`
      SELECT p.ordinal,p.parent_id,c.level,c.first_slot_id,c.last_slot_id,c.slot_count,c.chat_id,c.status,
        EXISTS(SELECT 1 FROM summary_revisions r WHERE r.id=p.parent_revision_id AND r.summary_id=c.id) AS revision_valid
      FROM summary_parents p LEFT JOIN summaries c ON c.id=p.parent_id WHERE p.summary_id=${id} ORDER BY p.ordinal`
      if (summary.level === 1) {
        if (
          children.length ||
          inputs.length !== chain.length ||
          inputs.some((i, n) => i.ordinal !== n || i.slot_id !== chain[n]!.id || !i.version_valid)
        )
          return false
      } else {
        if (inputs.length || !children.length) return false
        let at = 0
        for (const [n, child] of children.entries()) {
          if (
            child.ordinal !== n ||
            child.level >= summary.level ||
            child.chat_id !== summary.chat_id ||
            child.status === "failed" ||
            !child.revision_valid ||
            child.first_slot_id !== chain[at]?.id ||
            child.last_slot_id !== chain[at + child.slot_count - 1]?.id ||
            !(yield* valid(child.parent_id))
          )
            return false
          at += child.slot_count
        }
        if (at !== chain.length) return false
      }
      memo.set(id, true)
      return true
    })
  const displayValid = (summary: {
    id: string
    chat_id: string
    level: number
    first_slot_id: string
    last_slot_id: string
    slot_count: number
  }) =>
    Effect.gen(function* () {
      const pieces = view!.pieces!
      const inputs = yield* sql<{ ordinal: number; slot_id: string; version_valid: number }>`
        SELECT i.ordinal, i.slot_id, i.version_id IS NULL OR EXISTS(SELECT 1 FROM versions v WHERE v.id=i.version_id AND v.slot_id=i.slot_id) AS version_valid
        FROM summary_inputs i WHERE i.summary_id=${summary.id} ORDER BY i.ordinal`
      const children = yield* sql<{
        ordinal: number
        parent_id: string
        level: number
        first_slot_id: string
        last_slot_id: string
        slot_count: number
        chat_id: string
        status: string
        revision_valid: number
      }>`
        SELECT p.ordinal,p.parent_id,c.level,c.first_slot_id,c.last_slot_id,c.slot_count,c.chat_id,c.status,
          EXISTS(SELECT 1 FROM summary_revisions r WHERE r.id=p.parent_revision_id AND r.summary_id=c.id) AS revision_valid
        FROM summary_parents p LEFT JOIN summaries c ON c.id=p.parent_id WHERE p.summary_id=${summary.id} ORDER BY p.ordinal`
      const places = yield* placesOf(sql, summary.chat_id, [
        summary.first_slot_id,
        summary.last_slot_id,
        ...inputs.map((i) => i.slot_id),
        ...children.flatMap((c) => (c.first_slot_id ? [c.first_slot_id, c.last_slot_id] : []))
      ])
      const at = (slot: string) => positionIn(pieces, places.get(slot))
      const start = at(summary.first_slot_id),
        end = at(summary.last_slot_id)
      if (summary.level === 1)
        return (
          !children.length &&
          inputs.length === summary.slot_count &&
          inputs.every((i, n) => i.ordinal === n && i.version_valid) &&
          inputs[0]?.slot_id === summary.first_slot_id &&
          inputs.at(-1)?.slot_id === summary.last_slot_id &&
          followsInDisplay(
            pieces,
            inputs.map((i) => [at(i.slot_id), at(i.slot_id)] as const),
            start,
            end
          )
        )
      if (inputs.length || !children.length) return false
      let count = 0
      for (const [n, child] of children.entries()) {
        if (
          child.ordinal !== n ||
          child.level >= summary.level ||
          child.chat_id !== summary.chat_id ||
          child.status === "failed" ||
          !child.revision_valid ||
          !(yield* valid(child.parent_id))
        )
          return false
        count += child.slot_count
      }
      return (
        count === summary.slot_count &&
        followsInDisplay(
          pieces,
          children.map((c) => [at(c.first_slot_id), at(c.last_slot_id)] as const),
          start,
          end
        )
      )
    })
  return valid
}

/**
 * A separate context's view of the summaries (spec/CHARACTER-CONTEXT.md §2.3): its character's
 * identities. Its layer is the shared summaries ending before its first message it didn't know,
 * then summaries whose audience is among its identities. Absent: the shared summaries only.
 */
export interface LayerView {
  readonly identities: ReadonlyArray<string>
}

export const selectSummaryLayer = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string | null,
  partialBatch = false,
  view?: LayerView
) =>
  Effect.gen(function* () {
    const [any] = yield* sql<{
      present: number
    }>`SELECT EXISTS(SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND s.sealed = 1 AND s.status IN ('complete', 'truncated')) AS present`
    if (!any?.present) return { summaries: [], cursor: null, cursorDepth: -1 }
    // In a fork that shows inserted slots, the path is its display path, and the numbers are positions.
    const shown = yield* pathView(sql, chatId, leaf)
    const candidates = yield* sql<{ id: string }>`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id FROM ${shown ? sql`(SELECT id FROM path UNION SELECT value FROM json_each(${insertedOnPath(shown)})) path` : sql`path`}
      JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
      WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status IN ('complete', 'truncated')
        AND (${partialBatch ? 1 : 0} OR s.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM summarization_jobs j INDEXED BY summarization_jobs_batch
          WHERE j.chat_id = s.chat_id AND j.batch_id = s.batch_id AND j.status IN ('pending', 'processing')))
        AND ${audienceScope(sql, "s", view?.identities)}`

    const valid = lineageValidator(sql, userId, shown ?? undefined)
    const memo = new Map<string, Summary>()
    const found: Array<Summary> = []
    // A view (db/lcmAudience.ts): the shared summaries end before its first message it didn't know.
    const unknownFrom =
      view === undefined || leaf === null ? null : yield* firstUnknownPosition(sql, chatId, leaf, view.identities)
    const sharedEnds =
      unknownFrom === null
        ? null
        : new Map(
            (yield* sql<{
              id: string
              depth: number
              chain_id: string
              slot: string
            }>`SELECT s.id, b.depth, b.chain_id, b.id AS slot FROM json_each(${JSON.stringify(candidates.map((c) => c.id))}) c
              JOIN summaries s ON s.id = c.value JOIN slots b ON b.id = s.last_slot_id WHERE s.audience_json IS NULL`).map(
              (row) =>
                [
                  row.id,
                  shown
                    ? (positionIn(shown.pieces, { id: row.slot, chainId: row.chain_id, depth: row.depth }) ?? -1)
                    : row.depth
                ] as const
            )
          )
    for (const candidate of candidates) {
      if (sharedEnds !== null && (sharedEnds.get(candidate.id) ?? -1) >= unknownFrom!) continue
      if (!(yield* valid(candidate.id))) continue
      const summary = yield* readSummary(sql, userId, candidate.id, undefined, memo, shown ?? undefined)
      if (
        summary.status === "superseded" ||
        (shown
          ? summary.to - summary.from + 1 < summary.slotCount
          : summary.to - summary.from + 1 !== summary.slotCount) ||
        (summary.content === "" && !summary.fresh)
      )
        continue
      // A stale one only when the view knew every message it was written from.
      if (view !== undefined && !summary.fresh && !(yield* inputsKnown(sql, summary.id, view.identities))) continue
      found.push(summary)
    }
    const ending = new Map<number, Array<Summary>>()
    for (const summary of shown ? seamStale(found, shown.pieces, shown.end + 1, extend) : found) {
      const options = ending.get(summary.to) ?? []
      options.push(summary)
      ending.set(summary.to, options)
    }
    const choices = yield* summaryChoices(sql, chatId)
    const redirects = new Map(choices.map((c) => [c.summary_id, c.chosen_id]))
    const activeChoice = (id: string): string => {
      const seen = new Set<string>()
      while (redirects.has(id) && redirects.get(id)! !== id && !seen.has(id)) {
        seen.add(id)
        id = redirects.get(id)!
      }
      return id
    }
    const chosen = new Set(choices.filter((c) => c.summary_id !== c.chosen_id).map((c) => activeChoice(c.chosen_id)))
    const dismissed = new Set(choices.filter((c) => c.summary_id !== c.chosen_id).map((c) => c.summary_id))
    for (const [end, options] of ending) {
      const allowed = options.filter((s) => !dismissed.has(s.id))
      if (allowed.length) ending.set(end, allowed)
      else ending.delete(end)
    }
    const protectedChoice = (s: Summary) => !dismissed.has(s.id) && (s.origin === "user" || s.origin === "imported")
    const protectedSummaries = [...ending.values()].flat().filter(protectedChoice)
    const includesChoice = (s: Summary, manual: Summary): boolean =>
      s.children.some((child) =>
        child.summaryId === manual.id
          ? child.revisionId === manual.revisionId
          : memo.has(child.summaryId) && includesChoice(memo.get(child.summaryId)!, manual)
      )
    for (const [end, options] of ending) {
      const allowed = options.filter(
        (s) =>
          !protectedSummaries.some(
            (manual) =>
              s.id !== manual.id &&
              s.origin === "generated" &&
              s.level >= manual.level &&
              s.from <= manual.from &&
              s.to >= manual.to &&
              !includesChoice(s, manual)
          )
      )
      if (allowed.length) ending.set(end, allowed)
      else ending.delete(end)
    }
    for (const options of ending.values())
      options.sort(
        (a, b) =>
          Number(protectedChoice(b)) - Number(protectedChoice(a)) ||
          Number(chosen.has(b.id)) - Number(chosen.has(a.id)) ||
          Number(b.fresh) - Number(a.fresh) ||
          b.level - a.level ||
          b.id.localeCompare(a.id)
      )
    let selected: Array<Summary> = []
    let expected: number | undefined
    for (const [end, options] of [...ending].sort(([a], [b]) => b - a)) {
      if (expected !== undefined && end > expected) continue
      if (expected !== undefined && end < expected) selected = []
      const summary = options[0]!
      selected.unshift(summary)
      expected = summary.from - 1
    }
    if (expected !== 0) selected = []
    const newest = selected.at(-1)
    // `cursorDepth` is the cursor's position on the display path: its depth in a fork without insertions.
    return { summaries: selected, cursor: newest?.lastSlotId ?? null, cursorDepth: newest ? newest.to - 1 : -1 }
  })

/** Failures only stand while their declared inputs still match the viewed path. */
export const selectFailedRanges = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string | null,
  cursorDepth: number,
  audience: string | null = null
) =>
  Effect.gen(function* () {
    const [any] = yield* sql<{ present: number }>`SELECT EXISTS(SELECT 1 FROM summaries s JOIN chats c ON c.id=s.chat_id
      WHERE s.chat_id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL AND s.sealed=1 AND s.level=1 AND s.status='failed') AS present`
    if (!any?.present) return []
    const shown = yield* pathView(sql, chatId, leaf)
    const rows = yield* sql<{ id: string }>`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id=s.chat_id
        WHERE s.id=${leaf} AND c.id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id=p.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id FROM ${shown ? sql`(SELECT id FROM path UNION SELECT value FROM json_each(${insertedOnPath(shown)})) path` : sql`path`}
      JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id=path.id
      WHERE s.chat_id=${chatId} AND s.sealed=1 AND s.level=1 AND s.status='failed' AND s.audience_json IS ${audience}`
    const valid = lineageValidator(sql, userId, shown ?? undefined),
      failures: Array<{ id: string; revision: string; from: number; to: number }> = []
    for (const row of rows) {
      if (!(yield* valid(row.id))) continue
      const summary = yield* readSummary(sql, userId, row.id, undefined, undefined, shown ?? undefined)
      if (summary.fresh && summary.from > cursorDepth + 1)
        failures.push({ id: summary.id, revision: summary.revisionId, from: summary.from, to: summary.to })
    }
    return failures.sort((a, b) => a.from - b.from || a.to - b.to || a.id.localeCompare(b.id))
  })
