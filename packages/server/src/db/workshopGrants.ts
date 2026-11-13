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
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { callsFrom } from "../agent/steps.ts"
import { capabilityDefaults, resolveMode, workshopCapabilities } from "../agent/capabilities.ts"

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
    const [row] = yield* sql<{
      chat_id: string
      status: string
    }>`SELECT r.chat_id, r.status FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    if (!row) return yield* new NotFound({ entity: "rollout", id: rolloutId })
    return row
  })

export const writeGrant = (sql: Sql, userId: string, chatId: string, capability: string, mode: string | null) =>
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
        if (mode === "off")
          yield* sql`UPDATE tool_approvals SET status = CASE WHEN status = 'allowed' THEN 'used' ELSE 'cancelled' END
            WHERE capability = ${capability} AND status IN ('pending', 'allowed')
              AND rollout_id IN (SELECT id FROM rollouts WHERE chat_id = ${chatId})`
      }).pipe(transaction(sql, "SetWorkshopGrant")),
    RequestToolApproval: ({ userId, rolloutId, toolCallId, digest, capability, prompt }) =>
      Effect.gen(function* () {
        const run = yield* ownedRollout(sql, userId, rolloutId)
        if (run.status !== "running") return yield* new ApprovalRefused({ message: "This run is no longer running." })
        const rows = yield* sql`INSERT INTO tool_approvals ${sql.insert({
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
        })} ON CONFLICT (rollout_id, tool_call_id) DO NOTHING RETURNING tool_call_id`
        if (rows.length !== 1)
          return yield* new ApprovalRefused({ message: "This call already asked. Use a new call." })
      }).pipe(transaction(sql, "RequestToolApproval")),
    AnswerToolApproval: ({ userId, rolloutId, toolCallId, digest, answer, note, storyAt }) =>
      Effect.gen(function* () {
        const { chat_id } = yield* ownedRollout(sql, userId, rolloutId)
        const [row] = yield* sql<{
          status: string
          digest: string
          capability: string
          prompt_json: string
        }>`SELECT status, digest, capability, prompt_json
          FROM tool_approvals WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (!row) return yield* new NotFound({ entity: "approval", id: toolCallId })
        const expectedAt = JSON.parse(row.prompt_json).storyAt
        if (answer !== "deny" && expectedAt && JSON.stringify(expectedAt) !== JSON.stringify(storyAt))
          return yield* new ApprovalRefused({
            message: "The story tab moved. Send the request again from its new position."
          })
        if (row.digest !== digest)
          return yield* new ApprovalRefused({ message: "This answer is for a different request. Look again." })
        const [run] = yield* sql<{ status: string }>`SELECT status FROM rollouts WHERE id = ${rolloutId}`
        if (row.status !== "pending" || run?.status !== "running")
          return yield* new ApprovalRefused({ message: "This was already answered." })
        const grants = yield* sql<{ capability: string; mode: "off" | "ask" | "allow" }>`SELECT capability, mode
          FROM workshop_grants WHERE chat_id = ${chat_id} AND owner_user_id = ${userId} AND target = ''
            AND (expires_at IS NULL OR expires_at > ${Date.now()})`
        if (
          resolveMode(
            { workshopCapabilities, capabilityDefaults },
            new Map(grants.map((g) => [g.capability, g.mode])),
            row.capability,
            "outside"
          ) === "off"
        )
          return yield* new ApprovalRefused({
            message: "This capability is turned off. Look again before allowing it."
          })
        if (answer === "allow_chat" && workshopCapabilities.get(row.capability)?.modes?.includes("allow") === false)
          return yield* new ApprovalRefused({ message: "This capability must ask each time." })
        yield* sql`UPDATE tool_approvals SET status = ${answer === "deny" ? "denied" : "allowed"}, answer = ${answer},
          note = ${note}, answered_at = ${Date.now()} WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (answer === "allow_chat") {
          yield* ownedWorkshop(sql, userId, chat_id)
          yield* writeGrant(sql, userId, chat_id, row.capability, "allow")
        }
      }).pipe(transaction(sql, "AnswerToolApproval")),
    SettleToolApproval: ({ userId, rolloutId, toolCallId, status }) =>
      Effect.gen(function* () {
        const run = yield* ownedRollout(sql, userId, rolloutId)
        if (status === "used" && run.status !== "running") return false
        if (status === "used") {
          const [approval] = yield* sql<{ capability: string }>`SELECT capability FROM tool_approvals
            WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
          const grants = yield* sql<{ capability: string; mode: "off" | "ask" | "allow" }>`SELECT capability, mode
            FROM workshop_grants WHERE chat_id = ${run.chat_id} AND owner_user_id = ${userId} AND target = ''
              AND (expires_at IS NULL OR expires_at > ${Date.now()})`
          if (
            !approval ||
            resolveMode(
              { workshopCapabilities, capabilityDefaults },
              new Map(grants.map((g) => [g.capability, g.mode])),
              approval.capability,
              "outside"
            ) === "off"
          )
            return false
        }
        const rows = yield* status === "used"
          ? sql`UPDATE tool_approvals SET status = 'used'
              WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId} AND status = 'allowed' RETURNING tool_call_id`
          : sql`UPDATE tool_approvals SET status = 'cancelled'
              WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId} AND status = 'pending' RETURNING tool_call_id`
        return rows.length === 1
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
        // The changes of the calls its message and the run's later messages made (an earlier
        // message's are left out): its own run's, and those of calls it kept from the runs it
        // was resumed from. A kept call carries its result over; a call made again under the
        // same id has a result of its own, so an earlier run's change isn't listed for it.
        const runs = yield* lineage(sql, version.rollout_id)
        const calls =
          version.transcript === null
            ? new Map<string, string | null>()
            : callsFrom(JSON.parse(version.transcript) as ReadonlyArray<AgentMessage>, versionId)
        const rows = yield* sql<Parameters<typeof toRolloutEffect>[0]>`SELECT e.* FROM rollout_effects e
          WHERE e.rollout_id IN ${sql.in(runs.map((r) => r.id))}
          ORDER BY e.created_at DESC, e.rollout_id DESC, e.tool_call_id DESC, e.seq DESC`
        const earlier = [...new Set(rows.map((r) => r.rollout_id))].filter((id) => id !== version.rollout_id)
        const results = new Map<string, Map<string, string | null>>()
        if (earlier.length > 0)
          for (const run of yield* sql<{ rollout_id: string; transcript: string | null }>`SELECT rollout_id,
              transcript_json AS transcript FROM rollout_payloads WHERE rollout_id IN ${sql.in(earlier)}`)
            results.set(
              run.rollout_id,
              run.transcript === null ? new Map() : callsFrom(JSON.parse(run.transcript) as ReadonlyArray<AgentMessage>)
            )
        return rows
          .filter((row) => {
            if (!calls.has(row.tool_call_id)) return false
            if (row.rollout_id === version.rollout_id) return true
            const there = results.get(row.rollout_id)?.get(row.tool_call_id)
            return there !== undefined && there !== null && there === calls.get(row.tool_call_id)
          })
          .map(toRolloutEffect)
      }).pipe(query("VersionEffects"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
