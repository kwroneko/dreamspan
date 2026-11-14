import { resolveSummaryModel } from "../assembler/summaryModel.ts"
import { lcmPath } from "./lcmPath.ts"
import { CALL_TOOL, dispatcherMessages } from "../agent/dispatcher.ts"
import { recoveredOperationText } from "./operationReceipts.ts"
import { continuityEffectsReason, toRolloutEffect } from "./workshopEffects.ts"
import { budgetTokens } from "@rp/shared/imageTokens.ts"
import { WorkerAssembler } from "../assembler/assembler.ts"
import { prepareTextTokens } from "../assembler/textTokens.ts"
import { providerRequest } from "../assembler/wire.ts"
import type { AssembledRequest, ModelInput } from "../assembler/types.ts"
import { liveSuffix } from "../agent/messages.ts"
import { forTarget, rolloutRequest } from "../agent/wire.ts"
import type { Tool } from "@earendil-works/pi-ai"
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
import { loadPoints } from "../agent/toolLoading.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import { pathPieces, placedInsertions, positionOf } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import { forkThrough } from "./forks.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { pathSegments } from "./pathSegments.ts"
import { makeLibraryQueries } from "./library.ts"
import { REPLACEABLE_CARD_FIELDS } from "@rp/shared/docs/note.ts"
import { query } from "./tx.ts"
import { workshopDefaultsOf } from "./workshopDefaults.ts"
import { knowsSql, readKnowers } from "./knowers.ts"
import { threadStretches } from "./threadStretches.ts"
import { foldState } from "@rp/shared/state.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { resolveLcm } from "@rp/shared/lcmSettings.ts"
import { sqlSources } from "./assemblySources.ts"
import { AssemblySources } from "../assembler/pipeline.ts"
import { inFork } from "./forkState.ts"
import { withAssemblyModules } from "../assembler/modules.ts"

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
  const callStep = new Map(
    steps.flatMap((s, i) => (s.step.kind === "tool" ? [[`${s.message}:${s.step.id}`, i] as const] : []))
  )
  let assistantAt = -1
  const index = (step: number | undefined) => (step === undefined ? {} : { step })
  return messages.flatMap((m, at): Array<TranscriptEntry> => {
    if (m.role === "assistant") {
      assistantAt = at
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
    }
    if (m.role === "toolResult")
      return [
        {
          role: "toolResult",
          toolCallId: m.toolCallId,
          tool: m.toolName,
          text: textOf(m.content),
          isError: m.isError,
          ...index(callStep.get(`${assistantAt}:${m.toolCallId}`))
        }
      ]
    if (m.role === "rpCompaction")
      return [
        {
          role: "app",
          text: `Summarized transcript ${m.from}–${m.through - 1}${m.model ? ` with ${m.model}` : " (model not recorded)"}. Original steps remain available.\n${m.content}`
        }
      ]
    if (m.role === "rpUser") {
      request = 0
      return [{ role: "app", text: m.message.content + (m.message.images?.length ? " [image]" : "") }]
    }
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
      WHERE q.chat_id = ? AND q.owner_user_id = ? AND q.purpose NOT IN ('generation', 'workshop', 'test')
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
    UNION ALL
    SELECT r.id AS gid,'edit' AS kind,coalesce(r.started_at,r.created_at) AS started,r.completed_at AS ended,
      0 AS requests,0 AS running,0 AS input,0 AS cache_read,0 AS cache_write,0 AS output,0 AS cost,
      NULL AS currency,0 AS estimated,CASE WHEN r.status='completed' THEN 'complete' ELSE r.status END AS status,
      NULL AS model,NULL AS connection,NULL AS summary_id,NULL AS summary_revision_id,NULL AS slot_id
    FROM rollouts r JOIN chats c ON c.id=r.chat_id
    WHERE r.chat_id=? AND c.owner_user_id=? AND c.deleted_at IS NULL AND r.kind='edit'
      AND NOT EXISTS(SELECT 1 FROM llm_requests q WHERE q.rollout_id=r.id)
      AND (coalesce(r.started_at,r.created_at),r.id,'edit') < (?,?,?)
    ORDER BY started DESC,gid DESC,kind DESC LIMIT ?`,
    [
      chatId,
      userId,
      before.startedAt,
      before.id,
      before.kind,
      limit,
      chatId,
      userId,
      before.startedAt,
      before.id,
      before.kind,
      limit
    ]
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
  const assembler = yield* WorkerAssembler
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
        return stepsOf(JSON.parse(row.transcript) as ReadonlyArray<AgentMessage>, tools, row.running === 0, versionId)
      }).pipe(query("RolloutSteps")),

    HistoryProjectionNeeded: ({ userId, chatId, forkId, leafSlotId, viewers }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ current_fork_id: string | null }>`
          SELECT current_fork_id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const fork = forkId ?? (yield* forkThrough(sql, chatId, leafSlotId, chat.current_fork_id))?.id ?? null
        const [position] = yield* sql`
          SELECT 1 FROM forks f JOIN slots s ON s.chat_id = f.chat_id
          WHERE f.id = ${fork} AND f.chat_id = ${chatId} AND f.deleted_at IS NULL AND s.id = ${leafSlotId}`
        if (!position) return yield* new NotFound({ entity: "history position", id: chatId })
        // Joins are few. Locate just their slots among structural runs and placed insertions;
        // no message windows, selected prose, swipe scan or writer operation.
        const joins = yield* sql<{ id: string; chain_id: string; depth: number; timelines: string }>`
          SELECT s.id, s.chain_id, s.depth, m.timelines FROM chat_merges m JOIN slots s ON s.id = m.slot_id
          WHERE m.chat_id = ${chatId} AND NOT ${slotDeletedIn(sql, fork, "s")}`
        if (joins.length === 0) return false
        const pieces = yield* pathPieces(sql, chatId, fork, leafSlotId)
        const onPath = joins.filter(
          (j) => positionOf(pieces, { id: j.id, chainId: j.chain_id, depth: j.depth }) !== null
        )
        if (onPath.length === 0 || (viewers.includes(STRETCH_VIEW) && !onPath.some((j) => j.timelines === "separate")))
          return false
        const known = yield* knowsSql(sql, viewers, fork, true, leafSlotId)
        // readKnowers exempts a selected join's own speaker from fork-away corrections too.
        const [row] = yield* sql`
          SELECT 1 FROM json_each(${JSON.stringify(onPath.map((j) => j.id))}) asked
          CROSS JOIN slots s ON s.id = asked.value
          CROSS JOIN version_records v ON v.id = ${shownIn(sql, fork, "s")}
          WHERE v.status NOT IN ('generating', 'failed')
            AND (${known} OR v.speaker_entity_id IN (SELECT value FROM json_each(${JSON.stringify(viewers)})))
            AND NOT ${contextExcludedIn(sql, fork, "s")}
            AND EXISTS (SELECT 1 FROM chat_merges m JOIN chat_merge_messages mm ON mm.merge_id = m.id
              WHERE m.slot_id = s.id AND mm.included = 'verbatim' AND
                (EXISTS (SELECT 1 FROM json_each(coalesce(mm.knowers_json,
                  (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c
                    WHERE c.value ->> 'from' <> 'destination'))) k
                  WHERE k.value IN (SELECT value FROM json_each(${JSON.stringify(viewers)})))
                OR ${viewers.includes(STRETCH_VIEW) ? sql`m.timelines <> 'separate'` : sql`0`}))
          LIMIT 1`
        return row !== undefined
      }).pipe(query("HistoryProjectionNeeded")),

    SearchChat: ({ userId, chatId, forkId, leafSlotId, tokens, before, limit, viewers, ordinaryOnly }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ readonly current_fork_id: string | null }>`
          SELECT current_fork_id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const fork = forkId ?? (yield* forkThrough(sql, chatId, leafSlotId, chat.current_fork_id))?.id ?? null
        if (fork === null) return yield* new NotFound({ entity: "fork", id: chatId })
        if ((yield* placedInsertions(sql, chatId, fork)).length > 0) return null
        // FTS indexes a join as one text: the tools read it row by row, each row as its viewer
        // knew it (spec/THREADS.md §11), so a merged chat is searched over its path.
        const [merged] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM chat_merges WHERE chat_id = ${chatId}`
        if (merged!.n > 0 && !ordinaryOnly) return null
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
            AND ${ordinaryOnly ? sql`NOT EXISTS (SELECT 1 FROM chat_merges m WHERE m.slot_id = s.id)` : sql`1`}
            AND v.status NOT IN ('generating', 'failed') AND v.id = ${shownIn(sql, fork, "s")}
            AND NOT ${slotDeletedIn(sql, fork, "s")} AND NOT ${contextExcludedIn(sql, fork, "s")}
            AND ${viewers == null ? sql`1` : yield* knowsSql(sql, viewers, fork, false, leafSlotId)}`
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

    JoinRows: ({ userId, chatId, slotIds }) =>
      Effect.gen(function* () {
        const joins = yield* sql<{ id: string; slot_id: string; title: string; timelines: string }>`
          SELECT m.id, m.slot_id, m.title, m.timelines FROM json_each(${JSON.stringify(slotIds)}) asked
          CROSS JOIN chat_merges m ON m.slot_id = asked.value
          JOIN chats c ON c.id = m.chat_id
          WHERE m.chat_id = ${chatId} AND c.owner_user_id = ${userId}`
        if (joins.length === 0) return []
        const rows = yield* sql<{
          merge_id: string
          ordinal: number
          kind: "message" | "summary"
          speaker_name: string
          side: "user" | "assistant"
          speaker_entity_id: string | null
          content: string
          included: "verbatim" | "summarized" | "left_out"
          knowers: string
          source_join: number | null
          source_version_id: string | null
          source_from: number | null
          source_to: number | null
        }>`SELECT mm.merge_id, mm.ordinal, mm.kind, mm.speaker_name, mm.side, mm.speaker_entity_id, mm.content,
            mm.included, mm.source_version_id, mm.source_from, mm.source_to,
            CASE WHEN source_v.id IS NULL THEN NULL ELSE nested.slot_id IS NOT NULL END AS source_join,
            coalesce(mm.knowers_json, (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c
              WHERE c.value ->> 'from' <> 'destination')) AS knowers
          FROM json_each(${JSON.stringify(joins.map((j) => j.id))}) asked
          CROSS JOIN chat_merges m ON m.id = asked.value
          CROSS JOIN chat_merge_messages mm ON mm.merge_id = m.id
          LEFT JOIN versions source_v ON source_v.id = mm.source_version_id
          LEFT JOIN chat_merges nested ON nested.slot_id = source_v.slot_id
          ORDER BY mm.merge_id, mm.ordinal`
        return joins.map((join) => ({
          slotId: join.slot_id,
          title: join.title,
          timelines: join.timelines,
          rows: rows
            .filter((row) => row.merge_id === join.id)
            .map((row) => ({
              ordinal: row.ordinal,
              sourceVersionId: row.source_version_id,
              sourceJoin: row.source_join === null ? null : row.source_join === 1,
              kind: row.kind,
              name: row.speaker_name,
              side: row.side,
              speaker: row.speaker_entity_id,
              content: row.content,
              included: row.included,
              knowers: JSON.parse(row.knowers) as Array<string>,
              from: row.source_from,
              to: row.source_to
            }))
        }))
      }).pipe(query("JoinRows")),

    KnowersOf: ({ userId, chatId, forkId, leafSlotId, versionIds, viewers }) =>
      Effect.gen(function* () {
        // A fork of another chat is none of this one's: its corrections don't apply.
        const fork = forkId == null ? null : sql`(SELECT id FROM forks WHERE id = ${forkId} AND chat_id = ${chatId})`
        const ranges =
          leafSlotId !== undefined && viewers?.includes(STRETCH_VIEW)
            ? yield* threadStretches(sql, fork, leafSlotId, viewers)
            : undefined
        return yield* readKnowers(
          sql,
          chatId,
          sql`EXISTS (SELECT 1 FROM chats o WHERE o.id = ${chatId} AND o.owner_user_id = ${userId})`,
          versionIds,
          viewers,
          fork,
          ranges
        )
      }).pipe(query("KnowersOf")),

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

    WorkshopDefaults: ({ userId }) => workshopDefaultsOf(sql, userId).pipe(query("WorkshopDefaults")),
    ListRolloutEffects: ({ userId, chatId, before, limit }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{
          id: string
        }>`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const rows = yield* sql<
          Parameters<typeof toRolloutEffect>[0]
        >`SELECT e.* FROM rollout_effects e JOIN rollouts r ON r.id = e.rollout_id
        WHERE r.chat_id = ${chatId} AND ${before ? sql`(e.created_at, e.rollout_id, e.tool_call_id, e.seq) < (${before.createdAt}, ${before.rolloutId}, ${before.toolCallId}, ${before.seq})` : sql`1`}
        ORDER BY e.created_at DESC, e.rollout_id DESC, e.tool_call_id DESC, e.seq DESC LIMIT ${Math.max(1, Math.min(200, limit ?? 50))}`
        return rows.map(toRolloutEffect)
      }).pipe(query("ListRolloutEffects")),
    RolloutToolReceipt: ({ userId, rolloutId, toolCallId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          result_json: string | null
          is_error: number | null
        }>`SELECT receipt.result_json, receipt.is_error
        FROM rollouts r JOIN chats c ON c.id = r.chat_id LEFT JOIN rollout_receipts receipt ON receipt.rollout_id = r.id AND receipt.tool_call_id = ${toolCallId}
        WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        return row.result_json === null
          ? null
          : { text: recoveredOperationText(JSON.parse(row.result_json) as string), isError: row.is_error === 1 }
      }).pipe(query("RolloutToolReceipt")),
    RolloutReceipt: ({ userId, rolloutId, toolCallId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly result: string | null }>`
          SELECT receipt.result_json AS result FROM rollouts r JOIN chats c ON c.id = r.chat_id
          LEFT JOIN rollout_receipts receipt ON receipt.rollout_id = r.id AND receipt.tool_call_id = ${toolCallId}
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        return row.result === null ? null : (JSON.parse(row.result) as string)
      }).pipe(query("RolloutReceipt")),

    WorkshopSummaryContext: ({ userId, chatId, forkId, leafSlotId, rolloutId, transcript }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{
          kind: string
        }>`SELECT kind FROM chats WHERE id=${chatId} AND owner_user_id=${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        if (!chatKinds.get(chat.kind)?.summaryTranscript) return null
        const sources = sqlSources(sql, { userId, chatId, next: true, leafSlotId })
        const base = yield* Effect.map(AssemblySources, (s) => s).pipe(Effect.provide(sources.layer))
        const state = foldState((yield* base.events(leafSlotId)).map((e) => e.event))
        const account = yield* base.lcmDefaults!()
        const settings = resolveLcm(state.lcm, account)
        const { model } = yield* resolveSummaryModel(base, state.modelBindings)
        const candidates = yield* sql<{
          rollout: string
          call: string
          target: string
          result: string | null
        }>`SELECT e.rollout_id AS rollout,e.tool_call_id AS call,e.target_id AS target,receipt.result_json AS result
          FROM rollout_effects e JOIN rollouts r ON r.id=e.rollout_id
          LEFT JOIN rollout_receipts receipt ON receipt.rollout_id=e.rollout_id AND receipt.tool_call_id=e.tool_call_id
          WHERE r.chat_id=${chatId} AND e.undone_at IS NOT NULL
          ORDER BY e.undone_at,e.rollout_id,e.tool_call_id,e.seq`
        // Only calls actually visible before this position (or retained in this run) may
        // contribute facts. A chat-wide effects scan alone leaks future/alternate branches.
        const visible = new Map<string, Map<string, string>>()
        const add = (run: string, messages: ReadonlyArray<AgentMessage>, version?: string) => {
          let calls = visible.get(run)
          if (!calls) visible.set(run, (calls = new Map()))
          for (const { step } of placedSteps(messages, [], false, version))
            if (step.kind === "tool" && step.result !== undefined) calls.set(step.id, step.result)
        }
        if (candidates.length) {
          const path = leafSlotId === null ? [] : yield* lcmPath(sql, userId, chatId, leafSlotId)
          const versions = path.flatMap((s) => (s.versionId ? [s.versionId] : []))
          const parsed = new Map<string, ReadonlyArray<AgentMessage>>()
          for (const row of yield* sql<{ version: string; rollout: string; transcript: string | null }>`
            SELECT v.id AS version,v.rollout_id AS rollout,p.transcript_json AS transcript
            FROM json_each(${JSON.stringify(versions)}) wanted CROSS JOIN versions v ON v.id=wanted.value
            JOIN rollout_payloads p ON p.rollout_id=v.rollout_id`) {
            if (!row.transcript) continue
            let messages = parsed.get(row.rollout)
            if (!messages) parsed.set(row.rollout, (messages = JSON.parse(row.transcript) as Array<AgentMessage>))
            add(row.rollout, messages, row.version)
          }
          if (rolloutId && transcript) {
            const [run] = yield* sql`SELECT id FROM rollouts WHERE id=${rolloutId} AND chat_id=${chatId}`
            if (!run) return yield* new NotFound({ entity: "rollout", id: rolloutId })
            add(rolloutId, JSON.parse(transcript) as Array<AgentMessage>)
          }
        }
        const receipts = visible.size
          ? yield* sql<{ rollout: string; call: string; result: string }>`
          SELECT rollout_id AS rollout,tool_call_id AS call,result_json AS result FROM rollout_receipts
          WHERE rollout_id IN (SELECT value FROM json_each(${JSON.stringify([...visible.keys()])}))`
          : []
        // Equality alone is not provenance: independent runs commonly reuse ids and
        // return the same text (for example, two SetChatPin calls both return "Done").
        // Inherited effects must belong to the saved resume ancestry, never a future run.
        const ancestry = new Map<string, Set<string>>()
        if (visible.size)
          for (const row of yield* sql<{ kept: string; source: string }>`
            WITH RECURSIVE up(kept,source,depth) AS (
              SELECT value,value,0 FROM json_each(${JSON.stringify([...visible.keys()])})
              UNION
              SELECT up.kept,src.rollout_id,up.depth+1 FROM up
                JOIN versions v ON v.rollout_id=up.source AND v.origin='resumed' AND v.source_version_id IS NOT NULL
                JOIN versions src ON src.id=v.source_version_id
                JOIN rollouts r ON r.id=src.rollout_id AND r.chat_id=${chatId}
                WHERE up.depth<64
            ) SELECT DISTINCT kept,source FROM up`) {
            let sources = ancestry.get(row.kept)
            if (!sources) ancestry.set(row.kept, (sources = new Set()))
            sources.add(row.source)
          }
        const undone = candidates
          .filter((e) => {
            if (visible.get(e.rollout)?.has(e.call)) return true
            // A resumed run can retain a canonical effect through a copied receipt.
            return (
              e.result !== null &&
              receipts.some(
                (r) =>
                  ancestry.get(r.rollout)?.has(e.rollout) &&
                  r.call === e.call &&
                  r.result === e.result &&
                  visible.get(r.rollout)?.get(r.call) === recoveredOperationText(JSON.parse(r.result) as string)
              )
            )
          })
          .map((e) => ({ call: e.call, target: e.target, state: "undone" }))
        return model
          ? JSON.stringify({
              model,
              enabled: settings.enabled,
              target: settings.leafTarget,
              recentTarget: settings.recentTarget,
              recentMax: settings.recentMax,
              layerMax: settings.layerMax,
              tail: settings.tail,
              changes: JSON.stringify(undone)
            })
          : null
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("WorkshopSummaryContext"), (effect) =>
        withAssemblyModules(assembler, effect)
      ),
    CountRolloutContext: ({ model, request, transcript, tools, continuation, text }) =>
      Effect.gen(function* () {
        const target = JSON.parse(model) as ModelInput
        const count = yield* prepareTextTokens(assembler.textCounters.list(), target)
        if (text !== undefined) return count(text)
        const definitions = JSON.parse(tools) as ReadonlyArray<FrozenTool>
        const dispatch = definitions.some((t) => t.name === CALL_TOOL)
        const declared = dispatch ? definitions.filter((t) => !t.deferred) : definitions
        const assembled = JSON.parse(request) as AssembledRequest
        const history = JSON.parse(transcript) as Array<AgentMessage>
        const images = [
          ...assembled.messages.flatMap((m) => m.images ?? []),
          ...history.flatMap((m) => (m.role === "rpUser" ? (m.message.images ?? []) : []))
        ]
        const imageTokens = images.reduce((n, image) => n + budgetTokens(image.estimate), 0)
        const wire = rolloutRequest(
          providerRequest(assembled, target),
          target.api,
          forTarget(
            dispatch
              ? dispatcherMessages(
                  liveSuffix(history),
                  definitions
                    .filter((t) => t.deferred)
                    .map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters as Tool["parameters"]
                    }))
                )
              : liveSuffix(history),
            target
          ),
          declared as ReadonlyArray<Tool>,
          { replayReasoning: true, reasoningTarget: target }
        )
        const messages =
          target.api === "openai-completions"
            ? wire.payload.messages
            : wire.context.messages.map((m) => ({
                role: m.role,
                content: m.content,
                ...(m.role === "toolResult" ? { toolCallId: m.toolCallId, isError: m.isError } : {})
              }))
        return (
          imageTokens +
          count(JSON.stringify(messages)) +
          count(wire.context.systemPrompt ?? "") +
          count(JSON.stringify(declared)) +
          (continuation === undefined ? 0 : count(JSON.stringify({ role: "assistant", content: continuation })) + 3)
        )
      }).pipe(query("CountRolloutContext")),
    RolloutMaterial: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly rollout_id: string
          readonly status: string
          readonly version_status: string
          readonly resumed: number
          readonly mode: string | null
          readonly snapshot: string | null
          readonly transcript: string | null
        }>`
          SELECT r.id AS rollout_id, r.status, v.status AS version_status, r.mode,
            EXISTS (SELECT 1 FROM versions child WHERE child.rollout_id = r.id AND child.origin = 'resumed') AS resumed,
            p.context_snapshot_json AS snapshot, p.transcript_json AS transcript
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          JOIN rollouts r ON r.id = v.rollout_id LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND r.kind IN ('generation', 'workshop')
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row || row.snapshot === null) return yield* new NotFound({ entity: "rollout", id: versionId })
        return {
          rolloutId: row.rollout_id,
          status: row.status,
          versionStatus: row.version_status,
          resumed: !!row.resumed,
          effectsReason: JSON.parse(row.snapshot).continuity
            ? yield* continuityEffectsReason(sql, userId, row.rollout_id)
            : null,
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
          readonly model: string | null
        }>`
          SELECT p.transcript_json AS transcript, json_extract(p.context_snapshot_json, '$.agent.tools') AS tools,
            json_extract(p.context_snapshot_json, '$.agent.turnCap') AS turn_cap, r.id AS rollout_id,
            json_extract(p.context_snapshot_json, '$.inputs.model') AS model
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
        // Each definition's size with the model's own tokenizer, where the app has one.
        const count = yield* prepareTextTokens(
          assembler.textCounters.list(),
          row.model ? (JSON.parse(row.model) as ModelInput) : null
        )
        const loadedBy = new Map(
          loadPoints(messages, new Set(tools.filter((t) => t.deferred).map((t) => t.name))).flatMap((p) =>
            p.names.map((name) => [name, p.toolCallId] as const)
          )
        )
        return {
          tools: tools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            ...(t.capability ? { capability: t.capability } : {}),
            ...(t.titleField ? { titleField: t.titleField } : {}),
            effect: t.effect,
            tokens: count(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })),
            ...(t.deferred ? { deferred: true } : {}),
            ...(loadedBy.has(t.name) ? { loadedBy: loadedBy.get(t.name)! } : {})
          })),
          entries: transcriptEntries(messages, tools.length, turnCap, placedSteps(messages, tools, true, versionId)),
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
