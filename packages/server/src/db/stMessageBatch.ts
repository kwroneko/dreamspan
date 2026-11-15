// Prepare a new suffix before entering its writer transaction. Matching and re-imports
// still use the positional path; a suffix known to be new needs only two inserts.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { StMessage } from "../formats/stChat.ts"
import { recordedColumns } from "./rows.ts"

/**
 * The rows of `messages` as a new path, each under the one before. `slotIds`: ids the plan
 * already gave their slots (stImportPlanReads.ts); new ones otherwise. `castJson`: the cast the
 * file's finish pins on its imported versions, written with them instead of updated after.
 */
export const prepareStMessageBatch = (
  messages: ReadonlyArray<StMessage>,
  speakers: Readonly<Record<string, EntityId | null>>,
  slotIds?: ReadonlyArray<string>,
  castJson: string | null = null
) => {
  const versions: Array<Record<string, unknown>> = []
  const slots: Array<Record<string, unknown>> = []
  const ids: Array<SlotId> = []
  for (const [depth, message] of messages.entries()) {
    const slotId = (slotIds?.[depth] ?? uuidv7()) as SlotId
    const chosen = message.selected < message.versions.length ? message.selected : 0
    let selected = ""
    for (const [ordinal, version] of message.versions.entries()) {
      const id = uuidv7()
      if (ordinal === chosen) selected = id
      versions.push({
        id,
        slot_id: slotId,
        ordinal,
        speaker_entity_id: message.speaker === null ? null : (speakers[message.speaker] ?? null),
        writer: message.user ? "human" : "model",
        content: version.content,
        reasoning: version.reasoning,
        reply_sections: version.sections ? JSON.stringify(version.sections) : null,
        ...recordedColumns(version.generation),
        created_at: version.at,
        updated_at: version.at
      })
    }
    slots.push({
      id: slotId,
      parent: ids.at(-1) ?? null,
      depth,
      selected,
      hidden: message.hidden ? 1 : 0,
      at: message.versions[chosen]!.at
    })
    ids.push(slotId)
  }
  return {
    slotIds: ids,
    versions: versions.length,
    castJson,
    versionsJson: JSON.stringify(versions),
    slotsJson: JSON.stringify(slots)
  }
}

export const insertStMessageBatch = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  batch: ReturnType<typeof prepareStMessageBatch>,
  position: { chatId: string; forkId: string; parentId: string | null; depth: number }
) {
  if (batch.slotIds.length === 0) return
  yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, speaker_entity_id, writer, content,
    macro_mode, origin, authoring_fork_id, reasoning, reply_sections, recorded_model_json, recorded_generation_json,
    cast_json, created_at, updated_at)
    SELECT value ->> '$.id', value ->> '$.slot_id', value ->> '$.ordinal', 'complete',
      value ->> '$.speaker_entity_id', value ->> '$.writer', value ->> '$.content', 'verbatim', 'imported', ${position.forkId},
      value ->> '$.reasoning', value ->> '$.reply_sections', value ->> '$.recorded_model_json',
      value ->> '$.recorded_generation_json', ${batch.castJson}, value ->> '$.created_at', value ->> '$.updated_at'
    FROM json_each(${batch.versionsJson}) ORDER BY key`
  yield* sql`INSERT INTO slots (id, chat_id, fork_id, parent_slot_id, depth, selected_version_id, context_excluded, created_at)
    SELECT value ->> '$.id', ${position.chatId}, ${position.forkId},
      coalesce(value ->> '$.parent', ${position.parentId}), (value ->> '$.depth') + ${position.depth},
      value ->> '$.selected', value ->> '$.hidden', value ->> '$.at'
    FROM json_each(${batch.slotsJson}) ORDER BY key`
})
