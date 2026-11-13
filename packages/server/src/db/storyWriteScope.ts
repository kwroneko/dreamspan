// Worker-side validation shared by rewrite and operation transactions.
import { forkLabel } from "@rp/shared/branchNaming.ts"
import { chatForkSummaries } from "./forkSummaries.ts"
import type { ForkRow } from "./rows.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { StoryAt } from "@rp/shared/chat.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { historyFork } from "./historyShared.ts"
import { pathPieces, displaySlots, displayLength } from "./displayPath.ts"

export const checkStoryWrite = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  rolloutId: string,
  chatId: string,
  at: StoryAt | undefined
) {
  const [attachment] = yield* sql<{
    chat: string
    snapshot: string | null
  }>`SELECT p.context_snapshot_json AS snapshot, e.value_json ->> '$.chat' AS chat
    FROM rollouts r JOIN chats c ON c.id=r.chat_id JOIN state_events e ON e.chat_id=c.id
    LEFT JOIN rollout_payloads p ON p.rollout_id=r.id
    WHERE r.id=${rolloutId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL AND e.key='workshop.attached' LIMIT 1`
  if (!attachment) return undefined
  if (!at || attachment.chat !== chatId || at.chatId !== chatId)
    return yield* new HistoryRejected({ message: "Send this change from the Workshop tab beside its story." })
  const saved = attachment.snapshot ? (JSON.parse(attachment.snapshot) as { storyAt?: StoryAt }).storyAt : undefined
  if (!saved || saved.chatId !== at.chatId || saved.forkId !== at.forkId || saved.leafSlotId !== at.leafSlotId)
    return yield* new HistoryRejected({
      message: "This change must use the story position saved for this run. Send the request again."
    })
  const fork = yield* historyFork(sql, userId, chatId, at.forkId)
  const [active] =
    yield* sql`SELECT 1 FROM chats WHERE id=${chatId} AND owner_user_id=${userId} AND status='active' AND deleted_at IS NULL`
  if (!active) return yield* new HistoryRejected({ message: "The story is unavailable." })
  const pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
  const [leaf] =
    at.leafSlotId === null
      ? []
      : yield* sql<{ position: number }>`
    ${displaySlots(sql, pieces, 0, displayLength(pieces) - 1)}
    SELECT position FROM display_slots WHERE id=${at.leafSlotId}`
  if (at.leafSlotId !== null && !leaf)
    return yield* new HistoryRejected({
      message: "The story branch or position is unavailable. Send the request again."
    })
  const [branch] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id=${fork.id}`
  const summary = (yield* chatForkSummaries(sql, userId, chatId, [branch!])).get(fork.id)
  const naming = {
    name: branch!.name,
    original: branch!.parent_fork_id === null,
    split: summary?.split ?? null,
    createdAt: branch!.created_at
  }
  return {
    fork,
    pieces,
    upTo: leaf ? leaf.position + 1 : 0,
    naming,
    label: forkLabel(naming)
  }
})
