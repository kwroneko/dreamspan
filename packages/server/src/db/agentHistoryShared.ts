import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "@rp/shared/errors.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { capabilityDefaults, resolveMode, workshopCapabilities } from "../agent/capabilities.ts"
import { historyFork, historySummaryRevision } from "./historyShared.ts"
import { pathPieces, displaySlots, displayLength, displayEndOf } from "./displayPath.ts"
import { selectedIn, shownIn } from "./forkState.ts"

export interface WorkshopCall {
  readonly userId: string
  readonly rolloutId: string
  readonly toolCallId: string
  readonly approvalDigest?: string
}
/** Rechecked in the worker transaction; direct tool calls cannot bypass current consent. */
export const checkWorkshopAccess = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  key: WorkshopCall,
  capability: string
) {
  const [run] = yield* sql<{
    chat_id: string
    kind: string
    status: string
    chat_kind: string
  }>`SELECT r.chat_id, r.kind, r.status, c.kind AS chat_kind
    FROM rollouts r JOIN chats c ON c.id=r.chat_id WHERE r.id=${key.rolloutId} AND c.owner_user_id=${key.userId} AND c.deleted_at IS NULL`
  if (!run || run.kind !== "workshop" || !chatKinds.get(run.chat_kind)?.allowsOutside)
    return yield* new NotFound({ entity: "workshop rollout", id: key.rolloutId })
  if (!["running", "created"].includes(run.status))
    return yield* new EffectUndoRefused({ message: "This workshop run is no longer running." })
  const grants = yield* sql<{
    capability: string
    mode: "off" | "ask" | "allow"
  }>`SELECT capability,mode FROM workshop_grants
    WHERE chat_id=${run.chat_id} AND owner_user_id=${key.userId} AND target='' AND (expires_at IS NULL OR expires_at>${Date.now()})`
  const mode = resolveMode(
    { workshopCapabilities, capabilityDefaults },
    new Map(grants.map((g) => [g.capability, g.mode])),
    capability,
    "setup"
  )
  if (mode === "off")
    return yield* new EffectUndoRefused({ message: "This capability is turned off in this workshop." })
  if (mode === "ask") {
    const [approved] =
      yield* sql`SELECT 1 FROM tool_approvals WHERE rollout_id=${key.rolloutId} AND tool_call_id=${key.toolCallId}
      AND capability=${capability} AND digest=${key.approvalDigest ?? null} AND status='used'`
    if (!approved) return yield* new EffectUndoRefused({ message: "This call needs a current approval. Ask again." })
  }
  return run
})

/** Only the shown path's metadata is read, never its thousands of unselected swipes. */
export const agentHistorySnapshot = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  forkId: string
) {
  const fork = yield* historyFork(sql, userId, chatId, forkId)
  const pieces = yield* pathPieces(sql, chatId, forkId, fork.tip_slot_id)
  const [row] = yield* sql<{ name: string; stamp: string }>`
    ${displaySlots(sql, pieces, 0, displayLength(pieces) - 1)}
    SELECT c.title AS name, json_array(c.row_version,c.state_seq,c.current_fork_id,c.active_leaf_slot_id,f.row_version,f.tip_slot_id,
      (SELECT coalesce(json_group_array(json_array(s.id,s.row_version,${selectedIn(sql, forkId, "s")},v.id,v.updated_at,v.status,v.hidden,v.deleted_at,v.purged_at,
        (SELECT count(*) FROM version_history WHERE version_id=v.id))), '[]')
        FROM display_slots d JOIN slots s ON s.id=d.id JOIN version_records v ON v.id=${shownIn(sql, forkId, "s")}),
      (SELECT coalesce(json_group_array(json_array(s.id,${historySummaryRevision(sql, forkId, "s")})), '[]') FROM summaries s WHERE s.chat_id=c.id),
      (SELECT coalesce(max(seq),0) FROM state_events WHERE chat_id=c.id),
      (SELECT count(*) FROM history_changes WHERE chat_id=c.id),
      (SELECT coalesce(sum(revision),0) FROM history_changes WHERE chat_id=c.id)) AS stamp
    FROM chats c JOIN forks f ON f.id=${forkId} WHERE c.id=${chatId}`
  if (row!.stamp.length > 2_000_000)
    return yield* new HistoryRejected({ message: "This chat is too large for one rewrite. Use a smaller branch." })
  return {
    stamp: row!.stamp,
    name: row!.name,
    leaf: (yield* displayEndOf(sql, chatId, fork)) as import("@rp/shared/chat.ts").SlotId | null
  }
})
