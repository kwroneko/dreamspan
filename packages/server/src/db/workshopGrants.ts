// What the assistant may do in a workshop, and the calls that asked first (spec/WORKSHOP.md §3.4).
// Grants are the owner's rows, one a workshop, capability and target; approvals bind an answer to
// one call (its rollout, id and arguments' digest). Only the owner's own RPCs write either: the
// agent session hands its tools a writer without these operations (agent/tools.ts).
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { ApprovalRefused } from "@rp/shared/workshopApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"
import { toRolloutEffect } from "./workshopEffects.ts"

type Sql = SqlClient.SqlClient

/** How many runs back a resume's approval or effects are looked for. */
const RESUME_DEPTH = 64

/** A chat of the user's whose kind permits outside effects: a workshop. */
const ownedWorkshop = (sql: Sql, userId: string, chatId: string) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<{ kind: string }>`SELECT kind FROM chats
      WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    if (!chat || chatKinds.get(chat.kind)?.allowsOutside !== true)
      return yield* new NotFound({ entity: "workshop", id: chatId })
    return chat
  })

/** The rollout, in a chat the user owns. */
const ownedRollout = (sql: Sql, userId: string, rolloutId: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ chat_id: string }>`SELECT r.chat_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
    return row
  })

const writeGrant = (sql: Sql, userId: string, chatId: string, capability: string, mode: string | null) =>
  mode === null
    ? sql`DELETE FROM workshop_grants WHERE chat_id = ${chatId} AND capability = ${capability} AND target = ''`
    : sql`INSERT INTO workshop_grants ${sql.insert({
        chat_id: chatId,
        capability,
        target: "",
        owner_user_id: userId,
        mode,
        expires_at: null,
        updated_at: Date.now()
      })} ON CONFLICT (chat_id, capability, target) DO UPDATE SET mode = excluded.mode,
        expires_at = NULL, updated_at = excluded.updated_at`

export const makeWorkshopGrantWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetWorkshopGrant: ({ userId, chatId, capability, mode }) =>
      Effect.gen(function* () {
        yield* ownedWorkshop(sql, userId, chatId)
        yield* writeGrant(sql, userId, chatId, capability, mode)
      }).pipe(transaction(sql, "SetWorkshopGrant")),
    RequestToolApproval: ({ userId, rolloutId, toolCallId, digest, capability, prompt }) =>
      Effect.gen(function* () {
        yield* ownedRollout(sql, userId, rolloutId)
        // A call asked again in the same run (after a stop) starts waiting afresh; an answered one stays answered.
        yield* sql`INSERT INTO tool_approvals ${sql.insert({
          rollout_id: rolloutId,
          tool_call_id: toolCallId,
          digest,
          capability,
          prompt_json: JSON.stringify(prompt),
          status: "pending",
          answer: null,
          note: null,
          created_at: Date.now(),
          answered_at: null
        })} ON CONFLICT (rollout_id, tool_call_id) DO UPDATE SET status = 'pending', prompt_json = excluded.prompt_json
          WHERE tool_approvals.status = 'cancelled' AND tool_approvals.digest = excluded.digest`
      }).pipe(transaction(sql, "RequestToolApproval")),
    AnswerToolApproval: ({ userId, rolloutId, toolCallId, digest, answer, note }) =>
      Effect.gen(function* () {
        const { chat_id } = yield* ownedRollout(sql, userId, rolloutId)
        const [row] = yield* sql<{
          status: string
          digest: string
          capability: string
        }>`SELECT status, digest, capability
          FROM tool_approvals WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (!row) return yield* new NotFound({ entity: "approval", id: toolCallId })
        if (row.digest !== digest)
          return yield* new ApprovalRefused({ message: "This answer is for a different request. Look again." })
        if (row.status !== "pending" && row.status !== "cancelled")
          return yield* new ApprovalRefused({ message: "This was already answered." })
        yield* sql`UPDATE tool_approvals SET status = ${answer === "deny" ? "denied" : "allowed"}, answer = ${answer},
          note = ${note}, answered_at = ${Date.now()} WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (answer === "allow_chat") {
          yield* ownedWorkshop(sql, userId, chat_id)
          yield* writeGrant(sql, userId, chat_id, row.capability, "allow")
        }
      }).pipe(transaction(sql, "AnswerToolApproval")),
    SettleToolApproval: ({ userId, rolloutId, toolCallId, status }) =>
      Effect.gen(function* () {
        yield* ownedRollout(sql, userId, rolloutId)
        yield* status === "used"
          ? sql`UPDATE tool_approvals SET status = 'used'
              WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId} AND status = 'allowed'`
          : sql`UPDATE tool_approvals SET status = 'cancelled'
              WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId} AND status = 'pending'`
      }).pipe(transaction(sql, "SettleToolApproval"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

/**
 * The run and the runs it was resumed from, nearest first: through resumed versions' sources,
 * not `parent_rollout_id`, which a run carrying on the previous turn's also sets (bounded).
 */
const lineage = (sql: Sql, rolloutId: string) =>
  sql<{ id: string; depth: number }>`WITH RECURSIVE up(id, depth) AS (
      SELECT ${rolloutId}, 0
      UNION SELECT src.rollout_id, up.depth + 1 FROM up
        JOIN versions v ON v.rollout_id = up.id AND v.origin = 'resumed' AND v.source_version_id IS NOT NULL
        JOIN versions src ON src.id = v.source_version_id
        WHERE src.rollout_id IS NOT NULL AND up.depth < ${RESUME_DEPTH}
    ) SELECT id, min(depth) AS depth FROM up GROUP BY id ORDER BY depth`

/** The tool call ids a stored transcript holds. */
const callIds = (transcript: string | null) => {
  const ids = new Set<string>()
  if (transcript === null) return ids
  for (const message of JSON.parse(transcript) as ReadonlyArray<{ role?: string; content?: unknown }>)
    if (message.role === "assistant" && Array.isArray(message.content))
      for (const part of message.content as ReadonlyArray<{ type?: string; id?: string }>)
        if (part.type === "toolCall" && typeof part.id === "string") ids.add(part.id)
  return ids
}

export const makeWorkshopGrantReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    WorkshopGrants: ({ userId, chatId, now }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`SELECT id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        return yield* sql<{ capability: string; mode: "off" | "ask" | "allow" }>`SELECT capability, mode
          FROM workshop_grants WHERE chat_id = ${chatId} AND owner_user_id = ${userId} AND target = ''
            AND (expires_at IS NULL OR expires_at > ${now}) ORDER BY capability`
      }).pipe(query("WorkshopGrants")),
    ToolApprovalFor: ({ userId, rolloutId, toolCallId, digest }) =>
      Effect.gen(function* () {
        yield* ownedRollout(sql, userId, rolloutId)
        const runs = yield* lineage(sql, rolloutId)
        const [row] = yield* sql<{
          rollout_id: string
          status: "pending" | "allowed" | "denied" | "cancelled" | "used"
          note: string | null
        }>`SELECT a.rollout_id, a.status, a.note FROM tool_approvals a
          WHERE a.tool_call_id = ${toolCallId} AND a.digest = ${digest}
            AND a.rollout_id IN ${sql.in(runs.map((r) => r.id))}
          ORDER BY a.created_at DESC LIMIT 1`
        return row ? { rolloutId: row.rollout_id, status: row.status, note: row.note } : null
      }).pipe(query("ToolApprovalFor")),
    VersionEffects: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [version] = yield* sql<{ rollout_id: string | null; transcript: string | null }>`SELECT v.rollout_id,
            p.transcript_json AS transcript
          FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          LEFT JOIN rollout_payloads p ON p.rollout_id = v.rollout_id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!version) return yield* new NotFound({ entity: "version", id: versionId })
        if (version.rollout_id === null) return []
        // Its own run's changes, and those of the calls it kept from the runs it was resumed from.
        const runs = yield* lineage(sql, version.rollout_id)
        const kept = callIds(version.transcript)
        const rows = yield* sql<Parameters<typeof toRolloutEffect>[0]>`SELECT e.* FROM rollout_effects e
          WHERE e.rollout_id IN ${sql.in(runs.map((r) => r.id))}
          ORDER BY e.created_at DESC, e.rollout_id DESC, e.tool_call_id DESC, e.seq DESC`
        return rows
          .filter((row) => row.rollout_id === version.rollout_id || kept.has(row.tool_call_id))
          .map(toRolloutEffect)
      }).pipe(query("VersionEffects"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
