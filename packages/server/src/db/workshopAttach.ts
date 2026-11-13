import { createHash } from "node:crypto"
// Workshops beside a story (spec/WORKSHOP.md §4). The attachment lives only in the workshop: its
// chat-wide `workshop.attached { chat }` event names the story. Nothing is written in the story, so
// its requests and rows are the same with or without side chats; a story finds its workshops by
// the index on that event's value (baseline `state_events_workshop_attached`).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { query } from "./tx.ts"

export const makeWorkshopAttachReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    StoryReadStamp: ({ userId, chatId }) =>
      Effect.gen(function* () {
        // Only metadata leaves this worker. Include current speaker/library heads because
        // story message labels and template names resolve from them at read time.
        const [row] = yield* sql<{ stamp: string }>`SELECT json_array(c.shell_stamp, c.state_seq,
        (SELECT coalesce(json_group_array(json_array(id, row_version, selected_revision_id, status)), '[]')
          FROM (SELECT id, row_version, selected_revision_id, status FROM summaries WHERE chat_id = c.id ORDER BY id)),
        (SELECT coalesce(json_group_array(json_array(id, row_version, head_revision_id, deleted_at, purged_at)), '[]')
          FROM (SELECT r.id, r.row_version, r.head_revision_id, e.deleted_at, e.purged_at FROM entity_refs r
            JOIN entities e ON e.id = r.entity_id WHERE e.owner_user_id = c.owner_user_id ORDER BY r.id))) AS stamp
        FROM chats c WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND c.status = 'active'`
        if (!row) return yield* new NotFound({ entity: "story", id: chatId })
        return createHash("sha256").update(row.stamp).digest("hex")
      }).pipe(query("StoryReadStamp")),
    AttachedWorkshops: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [story] = yield* sql<{ id: string }>`SELECT id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL AND status = 'active'`
        if (!story) return yield* new NotFound({ entity: "chat", id: chatId })
        // Only the owner's own live workshops: the event's writer checked the story is theirs too.
        const rows = yield* sql<ChatRow>`SELECT c.* FROM state_events e JOIN chats c ON c.id = e.chat_id
          WHERE json_extract(e.value_json, '$.chat') = ${chatId} AND e.key = 'workshop.attached'
            AND e.slot_id IS NULL AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
            AND c.kind = 'workshop' AND c.status = 'active'
          GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT 200`
        return rows.map(toChat)
      }).pipe(query("AttachedWorkshops"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
