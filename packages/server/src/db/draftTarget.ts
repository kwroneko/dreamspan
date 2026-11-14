import type { DraftGenerationTarget } from "@rp/shared/generationTarget.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound, StaleWrite } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const checkDraftTarget = (sql: SqlClient.SqlClient, userId: UserId, target: DraftGenerationTarget) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ tip_slot_id: string | null; kind: string }>`
      SELECT f.tip_slot_id, c.kind FROM forks f JOIN chats c ON c.id=f.chat_id
      JOIN drafts d ON d.target_id=c.id AND d.field=f.id AND d.target_kind='composer'
      WHERE c.id=${target.chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        AND f.id=${target.forkId} AND f.deleted_at IS NULL AND d.id=${target.draftId} AND d.user_id=${userId}`
    if (!row || row.kind !== "rp") return yield* new NotFound({ entity: "composer", id: target.draftId })
    if (row.tip_slot_id !== target.leafSlotId)
      return yield* new StaleWrite({ entity: "branch", id: target.forkId, expected: 0, actual: 1 })
  })
