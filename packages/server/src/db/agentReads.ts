// Agent rollouts' reads (spec/AGENTIC.md §5): a version's steps, projected from its stored
// transcript with the tools its snapshot froze, as the live display projects the running one;
// the same transcript verbatim for the run inspector; and a chat's Activity, its model work
// that made no message, from the usage ledger.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ActivityRow, TranscriptEntry, TurnPart } from "@rp/shared/agent.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((p: { type?: string; text?: string }) => (p.type === "text" && p.text !== undefined ? [p.text] : []))
          .join("")
      : ""

/** What the loop added after the frozen request, as the model saw it; the request's own marker left out. */
const transcriptEntries = (messages: ReadonlyArray<AgentMessage>): Array<TranscriptEntry> =>
  messages.flatMap((m): Array<TranscriptEntry> => {
    if (m.role === "assistant")
      return [
        {
          role: "assistant",
          parts: m.content.flatMap((p): Array<TurnPart> =>
            p.type === "thinking"
              ? [{ type: "thinking", text: p.thinking }]
              : p.type === "text"
                ? [{ type: "text", text: p.text }]
                : p.type === "toolCall"
                  ? [{ type: "toolCall", id: p.id, name: p.name, args: p.arguments }]
                  : []
          ),
          stopReason: m.stopReason,
          ...(m.errorMessage ? { error: m.errorMessage } : {})
        }
      ]
    if (m.role === "toolResult")
      return [
        { role: "toolResult", toolCallId: m.toolCallId, tool: m.toolName, text: textOf(m.content), isError: m.isError }
      ]
    const other = m as { readonly role: string; readonly content?: unknown }
    if (other.role === "rpHarness" || other.role === "user") return [{ role: "app", text: textOf(other.content) }]
    return []
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
  readonly slot_id: string | null
}

const listActivity = (
  sql: SqlClient.SqlClient,
  { userId, chatId, before, limit }: { userId: UserId; chatId: ChatId; before: number; limit: number }
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
      HAVING min(q.started_at) < ?
      ORDER BY started DESC, gid DESC
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
      CASE WHEN last.kind = 'decision' THEN coalesce(
        (SELECT v.slot_id FROM versions v WHERE v.id = last.version_id AND v.deleted_at IS NULL),
        (SELECT r.slot_id FROM rollouts r WHERE r.id = last.rollout_id)
      ) END AS slot_id
    FROM last JOIN llm_requests q ON q.id = last.last_id LEFT JOIN connections c ON c.id = q.connection_id
    ORDER BY last.started DESC, last.gid DESC`,
    [chatId, userId, before, limit]
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
  slotId: row.slot_id
})

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
    RolloutTranscript: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly transcript: string | null; readonly tools: string | null }>`
          SELECT p.transcript_json AS transcript, json_extract(p.context_snapshot_json, '$.agent.tools') AS tools
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "version", id: versionId })
        const tools = row.tools ? (JSON.parse(row.tools) as ReadonlyArray<FrozenTool>) : []
        return {
          tools: tools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            effect: t.effect
          })),
          entries: row.transcript ? transcriptEntries(JSON.parse(row.transcript) as ReadonlyArray<AgentMessage>) : []
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
          before: before ?? Number.MAX_SAFE_INTEGER,
          limit: limit + 1
        })
        const page = rows.slice(0, limit).map(activityRow)
        return { rows: page, before: rows.length > limit ? page.at(-1)!.startedAt : null }
      }).pipe(query("ListActivity"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
