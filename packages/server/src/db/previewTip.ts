// A fork's last message start for a list, with a greeting's macros replaced as the chat shows
// them (db/previewText.ts): against the cast before the message, in that fork.
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { chatStateAt, previewNamesOf } from "./cards.ts"
import { shownIn } from "./forkState.ts"
import { previewText } from "./previewText.ts"

/** The start (`limit` characters) of the message `slotId` shows in fork `forkId`; empty without one. */
export const tipPreview = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  forkId: string,
  slotId: string | null,
  limit: number
) {
  if (slotId === null) return ""
  const [tip] = yield* sql<{ excerpt: string; template: number; speaker: string | null; parent: string | null }>`
    SELECT substr(v.content, 1, ${limit}) AS excerpt, v.macro_mode = 'template' AS template,
      v.speaker_entity_id AS speaker, t.parent_slot_id AS parent
    FROM slots t JOIN version_records v ON v.id = ${shownIn(sql, forkId, "t")}
    WHERE t.id = ${slotId}`
  if (tip === undefined) return ""
  if (tip.template !== 1) return tip.excerpt
  const state = yield* chatStateAt(sql, chatId as ChatId, tip.parent, forkId)
  const macro = {
    speaker: tip.speaker ?? state.participants.find((id) => !state.playedByMe.includes(id)) ?? null,
    user: state.playedByMe[0] ?? null
  }
  return previewText(tip.excerpt, macro, yield* previewNamesOf(sql, userId, [macro]))
})
