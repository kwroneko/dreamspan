// Which story branch each workshop branch goes with (spec/WORKSHOP-BRANCHES.md §2), shared by the
// reader and the writer. A workshop fork's pairing is the `workshop.paired` event of the nearest
// fork, itself or one it was made from, that wrote one. Only two writers write one: `CreateWorkshop`
// in the workshop's first fork, and the story-fork hook (workshopForks.ts) in the fork it has just
// made, before anything can be made from it. So every fork made from a writer later inherits its
// event, which is the fork-scoped event rule (db/forkLabels.ts) for this key, read structurally:
// up the fork's parents, or down from the writers through forks that wrote none.
import type { ChatId, ForkId, SlotId, StoryAt } from "@dreamspan/shared/chat.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayEndOf } from "./displayPath.ts"
import { nextSeq } from "./forkState.ts"
import type { ForkRow } from "./rows.ts"

/** SQL: fork `c` wrote a pairing of its own. One probe of `state_events_fork` and the key. */
const writesPairing = (c: string) =>
  `EXISTS (SELECT 1 FROM state_events p WHERE p.fork_id = ${c}.id AND p.key = 'workshop.paired')`

/** The story fork workshop fork `forkId` goes with; null for a workshop beside no story. */
const pairedStoryFork = (sql: SqlClient.SqlClient, forkId: string) =>
  Effect.map(
    sql<{ fork: string | null }>`WITH RECURSIVE up(id, n) AS (
        SELECT ${forkId}, 0
        UNION ALL SELECT f.parent_fork_id, up.n + 1 FROM up JOIN forks f ON f.id = up.id
          WHERE f.parent_fork_id IS NOT NULL AND NOT ${sql.literal(writesPairing("f"))})
      SELECT json_extract(e.value_json, '$.fork') AS fork FROM up
        JOIN state_events e ON e.fork_id = up.id AND e.key = 'workshop.paired'
      ORDER BY up.n, e.fork_seq DESC LIMIT 1`,
    ([row]) => row?.fork ?? null
  )

/**
 * Every fork of workshop `workshopId` with the story fork it goes with, its own branches
 * included (`story` null: a fork with no pairing, from before attachments had one). Costs the
 * workshop's own fork count, once (one grouped pass, joined by fork).
 */
export const workshopForkPairs = (sql: SqlClient.SqlClient, workshopId: string) =>
  sql<ForkRow & { story_fork_id: string | null }>`WITH RECURSIVE w(id, story) AS (
      SELECT e.fork_id, json_extract(e.value_json, '$.fork') FROM state_events e
        WHERE e.chat_id = ${workshopId} AND e.slot_id IS NULL AND e.key = 'workshop.paired'
      UNION ALL SELECT c.id, w.story FROM w JOIN forks c ON c.parent_fork_id = w.id
        WHERE NOT ${sql.literal(writesPairing("c"))})
    , one(id, story) AS MATERIALIZED (SELECT id, min(story) FROM w GROUP BY id)
    SELECT f.*, one.story AS story_fork_id
    FROM forks f LEFT JOIN one ON one.id = f.id WHERE f.chat_id = ${workshopId}`

/** The pairing writers and their descendants that inherit the same pairing. */
export const pairedWorkshopTree = (sql: SqlClient.SqlClient, storyId: string, forkId: string) =>
  sql`WITH RECURSIVE w(id) AS (
      SELECT e.fork_id FROM state_events e JOIN chats c ON c.id = e.chat_id
        WHERE json_extract(e.value_json, '$.fork') = ${forkId} AND e.key = 'workshop.paired'
          AND c.kind = 'workshop' AND c.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM state_events a WHERE a.chat_id = c.id AND a.key = 'workshop.attached'
            AND a.slot_id IS NULL AND json_extract(a.value_json, '$.chat') = ${storyId})
      UNION ALL SELECT c.id FROM w JOIN forks c ON c.parent_fork_id = w.id
        WHERE NOT ${sql.literal(writesPairing("c"))})`

/**
 * The live forks of the live workshops beside story `storyId` that go with its fork `forkId`,
 * the workshops' own branches included. One probe of `state_events_workshop_paired` finds the
 * writers (none: the common case, and nothing more is read); then their descendants.
 */
export const pairedWorkshopForks = (sql: SqlClient.SqlClient, storyId: string, forkId: string) =>
  sql<ForkRow>`${pairedWorkshopTree(sql, storyId, forkId)}
    SELECT f.* FROM w JOIN forks f ON f.id = w.id WHERE f.deleted_at IS NULL AND f.purged_at IS NULL
    ORDER BY f.chat_id, f.last_chatted_at IS NULL, f.last_chatted_at DESC, f.created_at DESC, f.id DESC`

/** The story a workshop is beside, when it's a live workshop of the user's: its `workshop.attached`. */
export const attachedStory = (sql: SqlClient.SqlClient, userId: string, workshopId: string) =>
  Effect.map(
    sql<{ story: string; current_fork_id: string | null }>`
      SELECT json_extract(a.value_json, '$.chat') AS story, w.current_fork_id FROM chats w
        JOIN state_events a ON a.chat_id = w.id AND a.key = 'workshop.attached' AND a.slot_id IS NULL
      WHERE w.id = ${workshopId} AND w.owner_user_id = ${userId} AND w.kind = 'workshop' LIMIT 1`,
    ([row]) => row ?? null
  )

/**
 * Where workshop fork `forkId` (null: the workshop's current one) reads its story now (§2.2): its
 * paired branch up to that branch's display end. Null when it isn't beside a story, or the story
 * or the paired branch isn't live.
 */
export const storyPositionOf = (sql: SqlClient.SqlClient, userId: string, workshopId: string, forkId: string | null) =>
  Effect.gen(function* () {
    const attached = yield* attachedStory(sql, userId, workshopId)
    const fork = forkId ?? attached?.current_fork_id ?? null
    if (attached === null || fork === null) return null
    const paired = yield* pairedStoryFork(sql, fork)
    if (paired === null) return null
    const [story] = yield* sql<{ id: string; tip_slot_id: string | null }>`
      SELECT f.id, f.tip_slot_id FROM forks f JOIN chats s ON s.id = f.chat_id
      WHERE f.id = ${paired} AND s.id = ${attached.story} AND f.deleted_at IS NULL
        AND s.owner_user_id = ${userId} AND s.deleted_at IS NULL AND s.status = 'active'`
    if (!story) return null
    const leaf = yield* displayEndOf(sql, attached.story, story)
    return {
      chatId: attached.story as ChatId,
      forkId: paired as ForkId,
      leafSlotId: leaf as SlotId | null
    } satisfies StoryAt
  })

/**
 * Records where the story stands on the versions just written in a workshop beside it (§2.2):
 * `workshop.story_at` on each, the paired branch's newest message now (null for an empty branch).
 * Nothing in other chats (one probe of the chat's kind).
 */
export const recordStoryAt = (
  sql: SqlClient.SqlClient,
  chatId: string,
  slotId: string,
  versionIds: ReadonlyArray<string>,
  forkId: string | null
) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<{ kind: string; owner_user_id: string; current_fork_id: string | null }>`
      SELECT kind, owner_user_id, current_fork_id FROM chats WHERE id = ${chatId}`
    if (chat?.kind !== "workshop") return
    const fork = forkId ?? chat.current_fork_id
    const at = yield* storyPositionOf(sql, chat.owner_user_id, chatId, fork)
    if (at === null || fork === null) return
    // A greeting has none: it counts as before the story's first message (§2.2).
    const written = yield* sql<{ id: string }>`SELECT id FROM versions
      WHERE id IN ${sql.in(versionIds)} AND origin <> 'greeting' ORDER BY ordinal`
    for (const { id: versionId } of written) {
      const [next] = yield* sql<{ n: number }>`
        SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id = ${slotId}`
      yield* sql`INSERT INTO state_events ${sql.insert({
        id: uuidv7(),
        chat_id: chatId,
        slot_id: slotId,
        version_id: versionId,
        seq: next!.n,
        fork_id: fork,
        fork_seq: yield* nextSeq(sql, chatId),
        key: "workshop.story_at",
        scope: null,
        value_json: JSON.stringify({ leaf: at.leafSlotId }),
        origin: "user",
        created_at: Date.now()
      })}`
    }
  })

/** Writes `workshop.paired { fork: storyForkId }` in workshop fork `forkId`, just made. */
export const writePairing = (sql: SqlClient.SqlClient, workshopId: string, forkId: string, storyForkId: string) =>
  Effect.gen(function* () {
    const [next] = yield* sql<{ n: number }>`
      SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${workshopId} AND slot_id IS NULL`
    yield* sql`INSERT INTO state_events ${sql.insert({
      id: uuidv7(),
      chat_id: workshopId,
      slot_id: null,
      version_id: null,
      seq: next!.n,
      fork_id: forkId,
      fork_seq: yield* nextSeq(sql, workshopId),
      key: "workshop.paired",
      scope: null,
      value_json: JSON.stringify({ fork: storyForkId }),
      origin: "user",
      created_at: Date.now()
    })}`
  })
