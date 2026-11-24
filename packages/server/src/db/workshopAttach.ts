import { createHash } from "node:crypto"
// Workshops beside a story (spec/WORKSHOP.md §4). The attachment lives only in the workshop: its
// chat-wide `workshop.attached { chat }` event names the story. Nothing is written in the story, so
// its requests and rows are the same with or without side chats; a story finds its workshops by
// the index on that event's value (baseline `state_events_workshop_attached`).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { attachedStory, pairedWorkshopForks, storyPositionOf, workshopForkPairs } from "./workshopPairing.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { query } from "./tx.ts"
import { displaySlots, pathPieces, positionOf } from "./displayPath.ts"
import { slotDeletedIn } from "./forkState.ts"

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
    AttachedWorkshops: ({ userId, chatId, forkId }) =>
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
        if (forkId === undefined) return rows.map(toChat)
        // Beside one story branch: those with a live branch going with it (WORKSHOP-BRANCHES §8.1).
        // The one chatted in last first: each workshop's newest paired branch (listed first per chat).
        const recency = new Map<string, number>()
        for (const fork of yield* pairedWorkshopForks(sql, chatId, forkId))
          if (!recency.has(fork.chat_id)) recency.set(fork.chat_id, fork.last_chatted_at ?? fork.created_at)
        return rows
          .filter((row) => recency.has(row.id))
          .sort((a, b) => recency.get(b.id)! - recency.get(a.id)!)
          .map(toChat)
      }).pipe(query("AttachedWorkshops")),
    WorkshopBranches: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [workshop] = yield* sql<{ id: string }>`SELECT id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!workshop) return yield* new NotFound({ entity: "chat", id: chatId })
        const attached = yield* attachedStory(sql, userId, chatId)
        const forks = (yield* workshopForkPairs(sql, chatId)).filter((fork) => fork.deleted_at === null)
        const stories = new Map(
          attached === null
            ? []
            : (yield* sql<{ id: string; name: string | null; parent_fork_id: string | null; created_at: number }>`
                SELECT f.id, f.name, f.parent_fork_id, f.created_at FROM forks f JOIN chats s ON s.id = f.chat_id
                WHERE f.chat_id = ${attached.story} AND s.owner_user_id = ${userId} AND s.deleted_at IS NULL
                  AND f.deleted_at IS NULL`).map((f) => [f.id, f])
        )
        // The branch chatted in last first, as the side panel picks its default (§8.1).
        forks.sort(
          (a, b) =>
            (b.last_chatted_at ?? -1) - (a.last_chatted_at ?? -1) ||
            b.created_at - a.created_at ||
            b.id.localeCompare(a.id)
        )
        return forks.map((fork) => {
          const story = fork.story_fork_id === null ? undefined : stories.get(fork.story_fork_id)
          return {
            forkId: fork.id as ForkId,
            story:
              story === undefined
                ? null
                : {
                    chatId: attached!.story as ChatId,
                    forkId: story.id as ForkId,
                    name: story.name,
                    original: story.parent_fork_id === null,
                    createdAt: story.created_at
                  }
          }
        })
      }).pipe(query("WorkshopBranches")),
    WorkshopStoryPosition: ({ userId, chatId, forkId, versionId }) =>
      Effect.gen(function* () {
        // Where the version recorded the story standing (an edit's: its source's), and in which fork.
        const [recorded] =
          versionId === undefined
            ? []
            : yield* sql<{ leaf: string | null; fork_id: string }>`SELECT json_extract(e.value_json, '$.leaf') AS leaf,
                e.fork_id FROM state_events e JOIN versions v ON v.id = ${versionId}
              WHERE e.chat_id = ${chatId} AND e.key = 'workshop.story_at'
                AND (e.version_id = v.id OR e.version_id = v.source_version_id)
              ORDER BY e.version_id = v.id DESC LIMIT 1`
        const now = yield* storyPositionOf(sql, userId, chatId, forkId ?? recorded?.fork_id ?? null)
        if (now === null || !recorded) return now
        if (recorded.leaf === null) return { ...now, leafSlotId: null }
        // A position the paired branch doesn't show (a message copied with "As it is now", recorded
        // on the original branch past the fork point) falls back to the branch's end now.
        const [fork] = yield* sql<{
          tip_slot_id: string | null
        }>`SELECT tip_slot_id FROM forks WHERE id = ${now.forkId}`
        const [place] = yield* sql<{ chain_id: string; depth: number; deleted: number }>`
          SELECT chain_id, depth, ${slotDeletedIn(sql, now.forkId, "s")} AS deleted FROM slots s
          WHERE id = ${recorded.leaf} AND chat_id = ${now.chatId}`
        if (!fork || !place) return now
        const pieces = yield* pathPieces(sql, now.chatId, now.forkId, fork.tip_slot_id)
        const position = positionOf(pieces, { id: recorded.leaf, chainId: place.chain_id, depth: place.depth })
        if (position === null) return now
        if (place.deleted === 0) return { ...now, leafSlotId: recorded.leaf as SlotId }
        // A deleted slot can still be on the path. Stay within the recorded boundary.
        const [previous] = yield* sql<{ id: SlotId }>`${displaySlots(sql, pieces, 0, position - 1)}
          SELECT d.id FROM display_slots d JOIN slots s ON s.id = d.id
          WHERE NOT ${slotDeletedIn(sql, now.forkId, "s")} ORDER BY d.position DESC LIMIT 1`
        return { ...now, leafSlotId: previous?.id ?? null }
      }).pipe(query("WorkshopStoryPosition")),
    WorkshopStories: ({ userId, chatIds }) =>
      Effect.gen(function* () {
        if (chatIds.length === 0) return []
        // The newest attachment event of each of the user's workshops; the story's title only
        // while it's live and the user's (a deleted or purged story reads as deleted: null).
        const rows = yield* sql<{ workshopId: string; storyId: string; title: string | null }>`
          SELECT w.id AS workshopId, json_extract(e.value_json, '$.chat') AS storyId,
            (SELECT s.title FROM chats s WHERE s.id = json_extract(e.value_json, '$.chat')
              AND s.owner_user_id = ${userId} AND s.deleted_at IS NULL AND s.status = 'active') AS title
          FROM chats w JOIN state_events e ON e.chat_id = w.id
          WHERE w.id IN ${sql.in(chatIds.slice(0, 500))} AND w.owner_user_id = ${userId}
            AND e.key = 'workshop.attached' AND e.slot_id IS NULL
          GROUP BY w.id`
        return rows.map((r) => ({
          workshopId: r.workshopId as ChatId,
          storyId: r.storyId as ChatId,
          title: r.title
        }))
      }).pipe(query("WorkshopStories"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
