// Agent rollouts' reads (spec/AGENTIC.md §5): a version's steps, projected from its stored
// transcript with the tools its snapshot froze, as the live display projects the running one;
// the same transcript verbatim for the run inspector; and a chat's Activity, its model work
// that made no message, from the usage ledger.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { ActivityCursor, ActivityRow, CutSpan, TranscriptEntry, TurnPart } from "@rp/shared/agent.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type PlacedStep, placedSteps, stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { placedInsertions } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import { forkThrough } from "./forks.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { pathSegments } from "./pathSegments.ts"
import { makeLibraryQueries } from "./library.ts"
import { REPLACEABLE_CARD_FIELDS } from "@rp/shared/docs/note.ts"
import { query } from "./tx.ts"

/** At most this many full-text matches in the chat, SearchChat starts from them. */
const FEW = 2000
const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((p: { type?: string; text?: string }) => (p.type === "text" && p.text !== undefined ? [p.text] : []))
          .join("")
      : ""

/**
 * What the loop added after the frozen request, as the model saw it; the request's own marker left
 * out. `steps`: each step's place (`placedSteps`), so a part or result says which step it is
 * (none for a cut span, whose steps aren't the version's). `requests`: the requests before these.
 */
const transcriptEntries = (
  messages: ReadonlyArray<AgentMessage>,
  tools: number,
  turnCap: number,
  steps: ReadonlyArray<PlacedStep> = [],
  requests = 0
): Array<TranscriptEntry> => {
  let request = requests
  const stepAt = new Map(steps.map((s, i) => [`${s.message}:${s.part}`, i]))
  const callStep = new Map(steps.flatMap((s, i) => (s.step.kind === "tool" ? [[s.step.id, i] as const] : [])))
  const index = (step: number | undefined) => (step === undefined ? {} : { step })
  return messages.flatMap((m, at): Array<TranscriptEntry> => {
    if (m.role === "assistant")
      return [
        {
          role: "assistant",
          parts: m.content.flatMap((p, part): Array<TurnPart> => {
            const step = index(stepAt.get(`${at}:${part}`))
            return p.type === "thinking"
              ? [{ type: "thinking", text: p.thinking, ...step }]
              : p.type === "text"
                ? [{ type: "text", text: p.text, ...step }]
                : p.type === "toolCall"
                  ? [{ type: "toolCall", id: p.id, name: p.name, args: p.arguments, ...step }]
                  : []
          }),
          stopReason: m.stopReason,
          toolsOffered: ++request < turnCap && tools > 0,
          ...(m.errorMessage ? { error: m.errorMessage } : {})
        }
      ]
    if (m.role === "toolResult")
      return [
        {
          role: "toolResult",
          toolCallId: m.toolCallId,
          tool: m.toolName,
          text: textOf(m.content),
          isError: m.isError,
          ...index(callStep.get(m.toolCallId))
        }
      ]
    const other = m as { readonly role: string; readonly content?: unknown }
    if (other.role === "rpHarness" || other.role === "user") return [{ role: "app", text: textOf(other.content) }]
    return []
  })
}

/**
 * The spans resuming dropped (`rollout_branches`), each placed where the kept transcript ends
 * (`fork_index`, a message index) as an index into the entries.
 */
const cutSpans = (
  messages: ReadonlyArray<AgentMessage>,
  branches: ReadonlyArray<{ readonly reason: string; readonly fork_index: number; readonly messages_json: string }>,
  tools: number,
  turnCap: number
): Array<CutSpan> =>
  branches.flatMap((b) => {
    if (b.reason !== "resume" && b.reason !== "edit") return []
    const before = messages.slice(0, b.fork_index)
    const requests = before.filter((m) => m.role === "assistant").length
    return [
      {
        reason: b.reason,
        at: transcriptEntries(before, tools, turnCap).length,
        entries: transcriptEntries(
          JSON.parse(b.messages_json) as ReadonlyArray<AgentMessage>,
          tools,
          turnCap,
          [],
          requests
        )
      }
    ]
  })

/** A sum, or null when any row's count is unknown: unknown is never zero. */
const known = (column: string) => `CASE WHEN count(${column}) = count(*) THEN sum(${column}) END`

interface ActivitySqlRow {
  readonly gid: string
  readonly kind: ActivityRow["kind"]
  readonly started: number
  readonly ended: number | null
  readonly requests: number
  readonly running: number
  readonly input: number | null
  readonly cache_read: number | null
  readonly cache_write: number | null
  readonly output: number | null
  readonly cost: number | null
  readonly currency: string | null
  readonly estimated: number
  readonly status: string | null
  readonly model: string | null
  readonly connection: string | null
  readonly summary_id: string | null
  readonly summary_revision_id: string | null
  readonly slot_id: string | null
}

const listActivity = (
  sql: SqlClient.SqlClient,
  { userId, chatId, before, limit }: { userId: UserId; chatId: ChatId; before: ActivityCursor; limit: number }
) =>
  // One row a rollout and purpose (a judgment rides on the reply's rollout), or a request without
  // a rollout; the last request names the model and the status. Reads the chat's ledger by its index.
  sql.unsafe<ActivitySqlRow>(
    `WITH g AS (
      SELECT coalesce(q.rollout_id, q.id) AS gid, q.rollout_id AS rollout_id, q.purpose AS kind,
        min(q.started_at) AS started, max(q.ended_at) AS ended, count(*) AS requests,
        sum(q.status = 'running') AS running,
        ${known("q.input_uncached")} AS input, ${known("q.cache_read")} AS cache_read,
        ${known("q.cache_write")} AS cache_write, ${known("q.output")} AS output,
        CASE WHEN count(q.cost) = count(*) AND count(DISTINCT q.cost_currency) <= 1 THEN sum(q.cost) END AS cost,
        max(q.cost_currency) AS currency, max(q.usage_source = 'estimated') AS estimated,
        max(q.version_id) AS version_id
      FROM llm_requests q
      WHERE q.chat_id = ? AND q.owner_user_id = ? AND q.purpose NOT IN ('generation', 'test')
      GROUP BY gid, q.purpose
      HAVING (min(q.started_at), gid, q.purpose) < (?, ?, ?)
      ORDER BY started DESC, gid DESC, kind DESC
      LIMIT ?
    ), last AS (
      SELECT g.*, (
        SELECT q.id FROM llm_requests q
        WHERE (g.rollout_id IS NULL AND q.id = g.gid) OR (q.rollout_id = g.rollout_id AND q.purpose = g.kind)
        ORDER BY q.started_at DESC, q.id DESC LIMIT 1
      ) AS last_id FROM g
    )
    SELECT last.gid, last.kind, last.started, last.ended, last.requests, last.running, last.input,
      last.cache_read, last.cache_write, last.output, last.cost, last.currency, last.estimated,
      q.status AS status, q.model_key AS model, c.name AS connection,
      CASE WHEN last.rollout_id IS NOT NULL AND last.kind IN ('summarize', 'condense') THEN coalesce(
        (SELECT sr.summary_id FROM summary_revisions sr WHERE sr.rollout_id = last.rollout_id LIMIT 1),
        (SELECT s.id FROM summaries s WHERE s.rollout_id = last.rollout_id LIMIT 1)
      ) END AS summary_id,
      CASE WHEN last.rollout_id IS NOT NULL AND last.kind IN ('summarize', 'condense') THEN
        (SELECT sr.id FROM summary_revisions sr WHERE sr.rollout_id = last.rollout_id LIMIT 1)
      END AS summary_revision_id,
      CASE WHEN last.kind = 'decision' THEN coalesce(
        (SELECT v.slot_id FROM versions v WHERE v.id = last.version_id AND v.deleted_at IS NULL),
        (SELECT r.slot_id FROM rollouts r WHERE r.id = last.rollout_id)
      ) END AS slot_id
    FROM last JOIN llm_requests q ON q.id = last.last_id LEFT JOIN connections c ON c.id = q.connection_id
    ORDER BY last.started DESC, last.gid DESC, last.kind DESC`,
    [chatId, userId, before.startedAt, before.id, before.kind, limit]
  )

const activityRow = (row: ActivitySqlRow): ActivityRow => ({
  id: row.gid,
  kind: row.kind,
  status: row.running > 0 ? "running" : (row.status ?? "unknown"),
  model: row.model,
  connection: row.connection,
  startedAt: row.started,
  endedAt: row.running > 0 ? null : row.ended,
  requests: row.requests,
  input: row.input,
  cacheRead: row.cache_read,
  cacheWrite: row.cache_write,
  output: row.output,
  cost: row.cost === null ? null : { amount: row.cost, currency: row.currency ?? "USD" },
  estimated: row.estimated === 1,
  summaryId: row.summary_id,
  summaryRevisionId: row.summary_revision_id,
  slotId: row.slot_id
})

export const makeAgentReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  return {
    AgentCards: ({ userId, chatId, entityIds, bindings }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        const cards = []
        for (const entityId of [...new Set(entityIds)].slice(0, 200)) {
          const library = yield* lib.cardLibraryRef(userId, entityId)
          if (library === null) continue
          const bound = bindings[entityId]
          const binding =
            bound && (bound.ref !== null || bound.revision !== null)
              ? { ref: bound.ref ?? undefined, revision: bound.revision ?? undefined }
              : undefined
          const used = yield* lib.cardInChat(userId, chatId, entityId, binding)
          const doc = yield* lib.loadDoc(used?.revisionId ?? library.head_revision_id)
          const text = (v: unknown) => (typeof v === "string" ? v : "")
          const editable = Array.isArray(doc["agent_editable_fields"]) ? doc["agent_editable_fields"] : []
          cards.push({
            entityId,
            name: text(doc["nickname"]) || text(doc["name"]),
            fields: Object.fromEntries(REPLACEABLE_CARD_FIELDS.map((f) => [f, text(doc[f])])),
            editableFields: editable.filter((f): f is string => typeof f === "string")
          })
        }
        return cards
      }).pipe(query("AgentCards")),

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
                FROM candidates h CROSS JOIN version_records v ON v.seq = h.seq CROSS JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId} AND ${onPath} AND ${shown}
                ORDER BY position DESC LIMIT ${limit}`
            : yield* sql<Row>`
                ${pathSegments(sql, chatId, leafSlotId, null)}
                SELECT s.depth AS position, v.speaker_entity_id AS speaker, v.writer, v.macro_mode, v.content
                FROM version_records v JOIN slots s ON s.id = v.slot_id
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

    RolloutReceipt: ({ userId, rolloutId, toolCallId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly result: string | null }>`
          SELECT receipt.result_json AS result FROM rollouts r JOIN chats c ON c.id = r.chat_id
          LEFT JOIN rollout_receipts receipt ON receipt.rollout_id = r.id AND receipt.tool_call_id = ${toolCallId}
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        return row.result === null ? null : (JSON.parse(row.result) as string)
      }).pipe(query("RolloutReceipt")),

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
      }).pipe(query("RolloutMaterial")),
    RolloutTranscript: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly transcript: string | null
          readonly tools: string | null
          readonly turn_cap: number | null
          readonly rollout_id: string
        }>`
          SELECT p.transcript_json AS transcript, json_extract(p.context_snapshot_json, '$.agent.tools') AS tools,
            json_extract(p.context_snapshot_json, '$.agent.turnCap') AS turn_cap, r.id AS rollout_id
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "version", id: versionId })
        const tools = row.tools ? (JSON.parse(row.tools) as ReadonlyArray<FrozenTool>) : []
        const messages = row.transcript ? (JSON.parse(row.transcript) as ReadonlyArray<AgentMessage>) : []
        const turnCap = row.turn_cap ?? Number.MAX_SAFE_INTEGER
        const branches = row.transcript
          ? yield* sql<{ readonly reason: string; readonly fork_index: number; readonly messages_json: string }>`
              SELECT reason, fork_index, messages_json FROM rollout_branches
              WHERE rollout_id = ${row.rollout_id} ORDER BY branch_no`
          : []
        return {
          tools: tools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            effect: t.effect
          })),
          entries: transcriptEntries(messages, tools.length, turnCap, placedSteps(messages, tools, true)),
          cut: cutSpans(messages, branches, tools.length, turnCap)
        }
      }).pipe(query("RolloutTranscript")),
    ListActivity: ({ userId, chatId, before, limit }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ readonly id: string }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const rows = yield* listActivity(sql, {
          userId,
          chatId,
          before: before ?? { startedAt: Number.MAX_SAFE_INTEGER, id: "", kind: "" },
          limit: limit + 1
        })
        const page = rows.slice(0, limit).map(activityRow)
        const last = page.at(-1)
        return {
          rows: page,
          before: rows.length > limit && last ? { startedAt: last.startedAt, id: last.id, kind: last.kind } : null
        }
      }).pipe(query("ListActivity"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
