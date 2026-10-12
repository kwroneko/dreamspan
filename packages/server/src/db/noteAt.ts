// Resolve the editor through the same branch binding the assembler reads (DESIGN §3.4).
import type { UserId } from "@rp/shared/domain.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { makeLibraryQueries, RefRow } from "./library.ts"
import { NotFound } from "./ops.ts"

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
  if (ref.kind !== "note" || (head.owner as { chat?: string } | undefined)?.chat !== chatId) {
    return yield* new NotFound({ entity: "note", id: ref.id })
  }
  const [binding] = yield* sql<{ revision: string }>`
      WITH RECURSIVE path(id) AS (
        SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
        UNION ALL
        SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
      )
      SELECT json_extract(e.value_json, '$.revision') AS revision FROM state_events e
      LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
      WHERE e.chat_id = ${chatId} AND e.key = 'note.binding' AND json_extract(e.value_json, '$.note') = ${ref.entity_id}
        AND e.superseded_by_changeset IS NULL
        AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
        AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
      ORDER BY coalesce(s.depth, -1) DESC, e.seq DESC LIMIT 1`
  if (!binding) return ref
  const [revision] = yield* sql<{
    id: string
  }>`SELECT id FROM entity_revisions WHERE id = ${binding.revision} AND entity_id = ${ref.entity_id}`
  if (!revision) return yield* new NotFound({ entity: "revision", id: binding.revision })
  return { ...ref, head_revision_id: revision.id }
})
