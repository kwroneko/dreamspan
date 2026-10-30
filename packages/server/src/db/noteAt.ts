import { eventApplies, inFork } from "./forkState.ts"
// Resolve the editor through the same branch binding the assembler reads (DESIGN §3.4).
import type { UserId } from "@rp/shared/domain.ts"
import { attachedApplies, slotDeletedIn, viewAt } from "./forkState.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { makeLibraryQueries, RefRow } from "./library.ts"
import { SUMMARY_HISTORY, summaryOnPath } from "../assembler/summary.ts"
import { noteHistory } from "./noteHistory.ts"
import { NotFound } from "./ops.ts"
import { displayEvents, displayThrough } from "./displayPath.ts"

export const noteAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  lib: ReturnType<typeof makeLibraryQueries>,
  userId: UserId,
  ref: RefRow,
  position: ChatNotePosition
) {
  const { chatId, slotId } = position
  const [chat] = yield* sql<{
    id: string
  }>`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
  if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
  if (slotId !== null) {
    const [slot] = yield* sql<{
      id: string
    }>`SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId} AND deleted_at IS NULL`
    if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
  }
  const head = yield* lib.loadDoc(ref.head_revision_id)
  // A binding attached to a version applies where the fork in view shows it.
  const fork = yield* viewAt(sql, chatId, slotId).pipe(inFork(sql, chatId, position.forkId, slotId))
  if (ref.kind !== "note" || (head.owner as { chat?: string } | undefined)?.chat !== chatId) {
    return yield* new NotFound({ entity: "note", id: ref.id })
  }
  // In a fork with insertions, the binding nearest before the slot in display order.
  const shown = yield* displayThrough(sql, chatId, fork, slotId)
  const [binding] = shown
    ? yield* sql<{ revision: string }>`
      ${displayEvents(sql, chatId, shown.pieces)}
      SELECT json_extract(e.value_json, '$.revision') AS revision FROM path_events e LEFT JOIN slots s ON s.id = e.slot_id
      WHERE e.key = 'note.binding' AND json_extract(e.value_json, '$.note') = ${ref.entity_id}
        AND ${eventApplies(sql, fork, "e")}
        AND (e.slot_id IS NULL OR NOT ${slotDeletedIn(sql, fork, "s")})
        AND ${attachedApplies(sql, fork, "s", "e.version_id")}
      ORDER BY coalesce(e.position, -1) DESC, e.seq DESC LIMIT 1`
    : yield* sql<{ revision: string }>`
      WITH RECURSIVE path(id) AS (
        SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
        UNION ALL
        SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
      )
      SELECT json_extract(e.value_json, '$.revision') AS revision FROM state_events e
      LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
      WHERE e.chat_id = ${chatId} AND e.key = 'note.binding' AND json_extract(e.value_json, '$.note') = ${ref.entity_id}
        AND ${eventApplies(sql, fork, "e")}
        AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND NOT ${slotDeletedIn(sql, fork, "s")}))
        AND ${attachedApplies(sql, fork, "s", "e.version_id")}
      ORDER BY coalesce(s.depth, -1) DESC, e.seq DESC LIMIT 1`
  const [revision] = yield* sql<{
    id: string
  }>`SELECT id FROM entity_revisions WHERE id = ${binding?.revision ?? ref.head_revision_id} AND entity_id = ${ref.entity_id}`
  if (!revision) return yield* new NotFound({ entity: "revision", id: binding?.revision ?? ref.head_revision_id })
  const current = yield* lib.loadDoc(revision.id)
  let doc = current
  let selected = revision.id
  if (current.kind === "imported_summary" && current.source_slot_id !== undefined) {
    const sources = noteHistory(sql, userId, chatId)
    const history = yield* sources.noteHistory(ref.entity_id, revision.id, SUMMARY_HISTORY)
    const slots = [
      ...new Set(history.flatMap(({ doc }) => (typeof doc.source_slot_id === "string" ? [doc.source_slot_id] : [])))
    ]
    const found = summaryOnPath(current, history, yield* sources.onPath(slotId, slots))
    doc = found?.doc ?? { ...current, content: "" }
    selected = found?.revision ?? revision.id
  }
  return { ref: { ...ref, head_revision_id: selected }, doc }
})
