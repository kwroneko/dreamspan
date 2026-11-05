// Agent rollouts' reads (spec/AGENTIC.md §5): a version's steps, projected from its stored
// transcript with the tools its snapshot froze, as the live display projects the running one.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { placedInsertions } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import { forkThrough } from "./forks.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { pathSegments } from "./pathSegments.ts"
import { query } from "./tx.ts"

/** At most this many full-text matches in the chat, SearchChat starts from them. */
const FEW = 2000

export const makeAgentReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RolloutSteps: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly transcript: string | null
          readonly tools: string | null
          readonly running: number
        }>`
          SELECT p.transcript_json AS transcript, json_extract(p.context_snapshot_json, '$.agent.tools') AS tools,
            r.status IN ('pending', 'running') AS running
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "version", id: versionId })
        if (!row.transcript) return []
        const tools = row.tools ? (JSON.parse(row.tools) as ReadonlyArray<FrozenTool>) : []
        return stepsOf(JSON.parse(row.transcript) as ReadonlyArray<AgentMessage>, tools, row.running === 0)
      }).pipe(query("RolloutSteps")),

    SearchChat: ({ userId, chatId, forkId, leafSlotId, tokens, before, limit }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ readonly current_fork_id: string | null }>`
          SELECT current_fork_id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const fork = forkId ?? (yield* forkThrough(sql, chatId, leafSlotId, chat.current_fork_id))?.id ?? null
        if (fork === null) return yield* new NotFound({ entity: "fork", id: chatId })
        if ((yield* placedInsertions(sql, chatId, fork)).length > 0) return null
        // Each token as the start of a word, quoted so FTS syntax in it is only text.
        const match = tokens.length ? tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" AND ") : null
        type Row = {
          readonly position: number
          readonly speaker: string | null
          readonly writer: string
          readonly macro_mode: string
          readonly content: string
        }
        const shown = sql`(${before} IS NULL OR s.depth < ${before})
            AND v.status NOT IN ('generating', 'failed') AND v.id = ${shownIn(sql, fork, "s")}
            AND NOT ${slotDeletedIn(sql, fork, "s")} AND NOT ${contextExcludedIn(sql, fork, "s")}`
        const onPath = sql`EXISTS (SELECT 1 FROM segments g WHERE g.chain_id = s.chain_id AND s.depth BETWEEN g.lo AND g.hi)`
        // Few matches in the whole chat (a rare word): start from them, each checked against the
        // path, with the path's template messages (matched once their names are filled in). Many
        // (a common word): walk the path newest first until the limit [P: 2,000].
        const [few] =
          match === null
            ? [{ n: Infinity }]
            : yield* sql<{ readonly n: number }>`
                SELECT count(*) AS n FROM (SELECT 1 FROM versions_fts WHERE versions_fts MATCH ${match} LIMIT ${FEW + 1})`
        const rows =
          match !== null && few!.n <= FEW
            ? yield* sql<Row>`
                ${pathSegments(sql, chatId, leafSlotId, null)},
                -- Materialized first, so the visibility checks run once per candidate only.
                candidates(seq) AS MATERIALIZED (
                  SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${match}
                  UNION
                  SELECT v.seq FROM segments g
                  CROSS JOIN slots s ON s.chain_id = g.chain_id AND s.depth BETWEEN g.lo AND g.hi
                  CROSS JOIN versions v ON v.slot_id = s.id
                  WHERE v.macro_mode = 'template')
                SELECT s.depth AS position, v.speaker_entity_id AS speaker, v.writer, v.macro_mode, v.content
                FROM candidates h CROSS JOIN versions v ON v.seq = h.seq CROSS JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId} AND ${onPath} AND ${shown}
                ORDER BY position DESC LIMIT ${limit}`
            : yield* sql<Row>`
                ${pathSegments(sql, chatId, leafSlotId, null)}
                SELECT s.depth AS position, v.speaker_entity_id AS speaker, v.writer, v.macro_mode, v.content
                FROM versions v JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId}
                  AND ${match === null ? sql`1` : sql`(v.seq IN (SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${match}) OR v.macro_mode = 'template')`}
                  AND ${onPath} AND ${shown}
                ORDER BY s.depth DESC LIMIT ${limit}`
        return rows.map((r) => ({
          position: r.position,
          speakerEntityId: r.speaker,
          writer: r.writer,
          macroMode: r.macro_mode,
          content: r.content
        }))
      }).pipe(query("SearchChat")),

    LookupLore: ({ userId, rolloutId, query: text, entry, limit }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly books: string | null }>`
          SELECT json_extract(p.context_snapshot_json, '$.agentLore') AS books
          FROM rollouts r JOIN chats c ON c.id = r.chat_id JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const books = row.books
          ? (JSON.parse(row.books) as ReadonlyArray<{ readonly id: string; readonly revision: string }>)
          : []
        const words = (text ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 0)
        const named = entry?.trim().toLowerCase() ?? null
        const found: Array<{
          readonly rank: number
          readonly hit: { book: string; uid: number; title: string; keys: Array<string>; content: string }
        }> = []
        for (const book of books) {
          const [doc] = yield* sql<{ readonly doc: string | null }>`
            SELECT ${sql.literal(book.id.startsWith("card:") ? "json_extract(doc_json, '$.character_book')" : "doc_json")} AS doc
            FROM entity_revisions WHERE id = ${book.revision}`
          if (!doc?.doc) continue
          const lorebook = JSON.parse(doc.doc) as LorebookDoc
          for (const e of lorebook.entries) {
            if (!e.enabled) continue
            const keys = [...e.keys, ...e.secondary_keys]
            const lowerKeys = keys.map((k) => k.toLowerCase())
            const all = [e.comment, e.content, ...keys].join("\n").toLowerCase()
            const rank =
              named !== null
                ? e.comment.trim().toLowerCase() === named || String(e.uid) === named
                  ? 0
                  : -1
                : words.length === 0 || !words.every((w) => all.includes(w))
                  ? -1
                  : words.every((w) => lowerKeys.some((k) => k.includes(w)))
                    ? 0
                    : 1
            if (rank < 0) continue
            found.push({
              rank,
              hit: { book: lorebook.name, uid: e.uid, title: e.comment, keys, content: e.content }
            })
          }
        }
        return {
          books: books.length,
          entries: found
            .sort((a, b) => a.rank - b.rank)
            .slice(0, limit)
            .map((f) => f.hit)
        }
      }).pipe(query("LookupLore")),

    RolloutMaterial: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly rollout_id: string
          readonly status: string
          readonly version_status: string
          readonly mode: string | null
          readonly snapshot: string | null
          readonly transcript: string | null
        }>`
          SELECT r.id AS rollout_id, r.status, v.status AS version_status, r.mode,
            p.context_snapshot_json AS snapshot, p.transcript_json AS transcript
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND r.kind = 'generation'
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row || row.snapshot === null) return yield* new NotFound({ entity: "rollout", id: versionId })
        return {
          rolloutId: row.rollout_id,
          status: row.status,
          versionStatus: row.version_status,
          mode: row.mode,
          snapshot: row.snapshot,
          transcript: row.transcript
        }
      }).pipe(query("RolloutMaterial"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
