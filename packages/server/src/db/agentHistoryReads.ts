import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { checkWorkshopAccess, agentHistorySnapshot } from "./agentHistoryShared.ts"
import { historyFork } from "./historyShared.ts"
import { pathPieces, displaySlots, displayLength } from "./displayPath.ts"
import { shownIn, selectedIn, slotDeletedIn, shownVersionDeletedIn } from "./forkState.ts"
import { query } from "./tx.ts"
import type { ReadOps } from "./ops.ts"

export const makeAgentHistoryReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    AgentHistorySnapshot: ({ userId, chatId, forkId, ...changed }) =>
      agentHistorySnapshot(sql, userId, chatId, forkId, changed).pipe(query("AgentHistorySnapshot")),
    AgentRewriteTargets: ({ userId, chatId, forkId, messages }) =>
      Effect.gen(function* () {
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        const [shown] = yield* sql`SELECT 1 FROM chats WHERE id=${chatId} AND current_fork_id=${forkId}`
        if (!shown) return yield* new HistoryRejected({ message: "The shown branch changed. Read the chat again." })
        const pieces = yield* pathPieces(sql, chatId, forkId, fork.tip_slot_id)
        if (!messages.length) return []
        return yield* sql<{ message: number; targetId: string; beforeId: string; before: string }>`
        ${displaySlots(sql, pieces, Math.min(...messages) - 1, Math.max(...messages) - 1)}
        SELECT d.position+1 AS message,${selectedIn(sql, forkId, "s")} AS targetId,v.id AS beforeId,v.content AS before
        FROM display_slots d JOIN slots s ON s.id=d.id JOIN version_records v ON v.id=${shownIn(sql, forkId, "s")}
        WHERE d.position+1 IN (SELECT value FROM json_each(${JSON.stringify(messages)}))
          AND NOT ${slotDeletedIn(sql, forkId, "s")} AND NOT ${shownVersionDeletedIn(sql, forkId, "v")}
          AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status<>'generating' ORDER BY d.position`
      }).pipe(query("AgentRewriteTargets")),
    ReadWorkshopChat: (input) =>
      Effect.gen(function* () {
        yield* checkWorkshopAccess(sql, input, "chats.read")
        const { userId, chatId, forkId, from, count, query: words, offset = 0 } = input
        if (from < 1 || count < 1 || count > 20 || offset < 0 || offset > 2_000_000 || (words?.length ?? 0) > 2000)
          return yield* new HistoryRejected({ message: "Read from a message number, at most 20 messages at a time." })
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        const [shown] = yield* sql`SELECT 1 FROM chats WHERE id=${chatId} AND current_fork_id=${forkId}`
        if (!shown) return yield* new HistoryRejected({ message: "The shown branch changed. Read the chat again." })
        const pieces = yield* pathPieces(sql, chatId, forkId, fork.tip_slot_id)
        // One bounded window per call, even a search with no hits. The cursor advances by scanned positions.
        const through = Math.min(displayLength(pieces) - 1, from - 1 + (words ? 100 : count) - 1)
        const tokens = words?.toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []
        if (words !== undefined && !tokens.length)
          return yield* new HistoryRejected({ message: "Give words to search for." })
        const start = words
          ? sql`max(0,instr(lower(v.content),${tokens[0] ?? ""})-121)`
          : sql`CASE WHEN d.position=${from - 1} THEN ${offset} ELSE 0 END`
        const rows = yield* sql<{
          message: number
          slotId: string
          version: string
          speaker: string
          text: string
          total: number
          offset: number
        }>`
        ${displaySlots(sql, pieces, from - 1, through)}
        SELECT d.position+1 AS message,s.id AS slotId,v.id AS version,coalesce(e.label,CASE WHEN v.writer='human' THEN 'User' ELSE 'Narrator' END) AS speaker,
          length(v.content) AS total,
          ${start} AS offset,
          substr(v.content,(${start})+1,6000) AS text
        FROM display_slots d JOIN slots s ON s.id=d.id JOIN version_records v ON v.id=${shownIn(sql, forkId, "s")}
        LEFT JOIN entity_refs e ON e.entity_id=v.speaker_entity_id
        WHERE NOT ${slotDeletedIn(sql, forkId, "s")} AND NOT ${shownVersionDeletedIn(sql, forkId, "v")}
          AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status<>'generating'
          AND NOT EXISTS(SELECT 1 FROM json_each(${JSON.stringify(tokens)}) q WHERE instr(lower(v.content),q.value)=0) ORDER BY d.position`
        const messages = []
        let used = 0
        let nextOffset: number | null = null
        let next = through + 1 < displayLength(pieces) ? through + 2 : null
        for (const row of rows) {
          if (messages.length >= count || used + row.text.length > 12000) {
            next = row.message
            break
          }
          const { total, ...message } = row
          messages.push(message)
          used += row.text.length
          const through = row.offset + [...row.text].length
          if (!words && through < total) {
            next = row.message
            nextOffset = through
            break
          }
        }
        return { messages, next, nextOffset }
      }).pipe(query("ReadWorkshopChat"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
