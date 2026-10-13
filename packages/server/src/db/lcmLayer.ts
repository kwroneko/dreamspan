import type { UserId } from "@rp/shared/domain.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { readSummary } from "./lcmReads.ts"

/** Recheck stored lineage before freshness recursion or advancing past originals. */
export const lineageValidator = (sql: SqlClient.SqlClient, userId: UserId) => {
  const memo = new Map<string, boolean>()
  const valid = (id: string): Effect.Effect<boolean, import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      if (memo.has(id)) return memo.get(id)!
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
      const chain = yield* sql<{ id: string; parent_slot_id: string | null; merged: number }>`
      WITH RECURSIVE chain(id,parent_slot_id,n) AS (
        SELECT id,parent_slot_id,1 FROM slots WHERE id=${summary.last_slot_id} AND chat_id=${summary.chat_id}
        UNION ALL SELECT s.id,s.parent_slot_id,c.n+1 FROM slots s JOIN chain c ON s.id=c.parent_slot_id
          WHERE c.n<${summary.slot_count} AND s.chat_id=${summary.chat_id}
      ) SELECT id,parent_slot_id,EXISTS(SELECT 1 FROM slot_parents p WHERE p.slot_id=chain.id) AS merged FROM chain ORDER BY n DESC`
      if (chain.length !== summary.slot_count || chain[0]?.id !== summary.first_slot_id || chain.some((s) => s.merged))
        return false
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
  return valid
}

export const selectSummaryLayer = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string | null,
  partialBatch = false
) =>
  Effect.gen(function* () {
    const [any] = yield* sql<{
      present: number
    }>`SELECT EXISTS(SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND s.sealed = 1 AND s.status IN ('complete', 'truncated')) AS present`
    if (!any?.present) return { summaries: [], cursor: null, cursorDepth: -1 }
    const candidates = yield* sql<{ id: string }>`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
      WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status IN ('complete', 'truncated')
        AND (${partialBatch ? 1 : 0} OR s.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM summarization_jobs j INDEXED BY summarization_jobs_batch
          WHERE j.chat_id = s.chat_id AND j.batch_id = s.batch_id AND j.status IN ('pending', 'processing')))`

    const valid = lineageValidator(sql, userId)
    const memo = new Map<string, Summary>()
    const ending = new Map<number, Array<Summary>>()
    for (const candidate of candidates) {
      if (!(yield* valid(candidate.id))) continue
      const summary = yield* readSummary(sql, userId, candidate.id, undefined, memo)
      if (summary.to - summary.from + 1 !== summary.slotCount || (summary.content === "" && !summary.fresh)) continue
      const options = ending.get(summary.to) ?? []
      options.push(summary)
      ending.set(summary.to, options)
    }
    const choices = yield* sql<{ summary_id: string; chosen_id: string }>`SELECT x.* FROM lcm_summary_choices x
      JOIN summaries s ON s.id=x.summary_id WHERE s.chat_id=${chatId}`
    const redirects = new Map(choices.map((c) => [c.summary_id, c.chosen_id]))
    const activeChoice = (id: string): string => {
      const seen = new Set<string>()
      while (redirects.has(id) && redirects.get(id)! !== id && !seen.has(id)) {
        seen.add(id)
        id = redirects.get(id)!
      }
      return id
    }
    const chosen = new Set(choices.map((c) => activeChoice(c.chosen_id)))
    const dismissed = new Set(choices.filter((c) => c.summary_id !== c.chosen_id).map((c) => c.summary_id))
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
    return { summaries: selected, cursor: newest?.lastSlotId ?? null, cursorDepth: newest ? newest.to - 1 : -1 }
  })
