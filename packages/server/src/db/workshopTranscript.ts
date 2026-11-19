import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { activeRunSummaries, summarySafeText } from "../agent/compaction.ts"
import { messageBounds, placedSteps } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"

/** One set-based, owner/chat-scoped read. A rollout's prefix is never summary material. */
export const workshopTranscript = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  versions: ReadonlyArray<string>
) {
  const found = new Map<string, string>()
  const [chat] = yield* sql<{
    kind: string
  }>`SELECT kind FROM chats WHERE id=${chatId} AND owner_user_id=${userId} AND deleted_at IS NULL`
  if (!chatKinds.get(chat?.kind ?? "")?.summaryTranscript || !versions.length) return found
  const rows = yield* sql<{ id: string; transcript: string | null; snapshot: string | null; rollout: string }>`
    SELECT v.id,p.transcript_json AS transcript,p.context_snapshot_json AS snapshot,r.id AS rollout
    FROM json_each(${JSON.stringify(versions)}) wanted CROSS JOIN versions v ON v.id=wanted.value
    JOIN slots s ON s.id=v.slot_id JOIN rollouts r ON r.id=v.rollout_id JOIN rollout_payloads p ON p.rollout_id=r.id
    WHERE s.chat_id=${chatId} AND r.chat_id=${chatId} AND r.kind='workshop'`
  for (const row of rows) {
    if (!row.transcript) continue
    const messages = JSON.parse(row.transcript) as Array<AgentMessage>
    const tools =
      (JSON.parse(row.snapshot ?? "{}") as { agent?: { tools?: ReadonlyArray<FrozenTool> } }).agent?.tools ?? []
    const steps = placedSteps(messages, tools, true, row.id)
    const bounds = messageBounds(messages, row.id, true)
    const summaries = activeRunSummaries(messages).filter(
      (s) =>
        s.from > bounds.after &&
        s.through <= bounds.through + 1 &&
        steps.some((p) => p.message >= s.from && p.message < s.through)
    )
    const material = steps.flatMap(({ step, message }) => {
      if (summaries.some((s) => message >= s.from && message < s.through)) return []
      return step.kind === "thinking"
        ? []
        : [step.kind === "tool" ? { ...step, ...(step.result ? { result: summarySafeText(step.result) } : {}) } : step]
    })
    // Include undone state independently of generated prose. Summaries can never authorize Undo.
    const effects = yield* sql<{ call: string; kind: string; target: string; title: string; undone: number | null }>`
      SELECT tool_call_id AS call,kind,target_id AS target,title,undone_at AS undone FROM rollout_effects
      WHERE rollout_id=${row.rollout} AND tool_call_id IN (SELECT value FROM json_each(${JSON.stringify(steps.flatMap(({ step }) => (step.kind === "tool" ? [step.id] : [])))})) ORDER BY created_at,tool_call_id,seq`
    found.set(
      row.id,
      summarySafeText(
        JSON.stringify({
          version: row.id,
          summaries: summaries.map((s) => ({ id: s.id, from: s.from, through: s.through, content: s.content })),
          steps: material,
          changes: effects.map((e) => ({ ...e, state: e.undone === null ? "completed" : "undone" }))
        })
      )
    )
  }
  return found
})
