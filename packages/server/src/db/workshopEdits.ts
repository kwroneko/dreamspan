import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { blockField, visibleBlockText } from "@dreamspan/shared/chat.ts"
import type { BlockEdits } from "@dreamspan/shared/chatApi.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { editWorkshopBlocks } from "../agent/workshopBlocks.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { type VersionRow, versionSteps } from "./rows.ts"

/** The caller owns both versions and runs this with the version write in one transaction. */
export const writeWorkshopEdit = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  source: VersionRow,
  target: string,
  fork: string,
  edits: BlockEdits
) {
  const blocks = versionSteps(source).blocks
  if (!source.rollout_id || !blocks) return yield* new NotFound({ entity: "workshop transcript", id: source.id })
  const [payload] = yield* sql<{ transcript_json: string }>`
    SELECT transcript_json FROM rollout_payloads WHERE rollout_id = ${source.rollout_id}`
  const transcript = JSON.parse(payload!.transcript_json) as Array<AgentMessage>
  const edited = editWorkshopBlocks(transcript, blocks, edits, source.id, target)
  if (!edited) return yield* new NotFound({ entity: "workshop text block", id: source.id })
  const json = JSON.stringify(transcript)
  if (source.id === target) {
    yield* sql`UPDATE rollout_payloads SET transcript_json = ${json} WHERE rollout_id = ${source.rollout_id}`
  } else {
    const rollout = uuidv7()
    yield* sql`INSERT INTO rollouts (id, chat_id, kind, status, slot_id, leaf_slot_id, parent_rollout_id,
      role, connection_id, model_id, request_class, created_at, started_at, updated_at, completed_at,
      context_issues_json, history_start_slot_id, history_start_depth, history_depth, fork_id, step_count, mode)
      SELECT ${rollout}, chat_id, kind, 'completed', slot_id, leaf_slot_id, id,
      role, connection_id, model_id, request_class, created_at, started_at, updated_at, completed_at,
      context_issues_json, history_start_slot_id, history_start_depth, history_depth, ${fork}, step_count, mode
      FROM rollouts WHERE id = ${source.rollout_id}`
    yield* sql`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json, sent_context_json)
      SELECT ${rollout}, context_snapshot_json, ${json}, sent_context_json FROM rollout_payloads WHERE rollout_id = ${source.rollout_id}`
    yield* sql`UPDATE versions SET rollout_id = ${rollout} WHERE id = ${target}`
  }
  const final = blocks.findLast((block) => block.kind === "text")
  return {
    content: visibleBlockText(edited),
    fields: edits.map((edit) => ({
      ...edit,
      field: final?.message === edit.message && final.part === edit.part ? "" : blockField(edit)
    }))
  }
})
