// The recycle bin (DESIGN §6.2), used by the writer. Deleting marks rows (deleted_at,
// bin_item_id) instead of removing them, so restoring puts things back exactly where
// they were. Two sections with independent capacities: deleted items and recovered text.
import { Buffer } from "node:buffer"
import { BinChanged, BinItem, type BinLimits, CannotDeleteLastFork, RecoveredText } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { composerKey, type DraftKey, excerpt } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Data, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { reachableSlot } from "./graphReachability.ts"
import { forkRecency, forksShowing, onPath, sharedDepth } from "./forks.ts"
import {
  effectiveOverride,
  forkAt,
  insertFork,
  originalSql,
  selectedIn,
  shownInSql,
  shownIn,
  slotDeletedIn,
  versionDeletedIn,
  writeOverride,
  writeSelect
} from "./forkState.ts"
import { recordReduction } from "./historyChanges.ts"
import { pathSegments } from "./pathSegments.ts"
import type { ForkRow } from "./rows.ts"
import { binItemForks } from "./binForks.ts"
import { makeDraftStore } from "./drafts.ts"
import { NotFound } from "./ops.ts"
import type { QueuedRow } from "./queueRows.ts"

interface BinRow {
  readonly id: string
  readonly kind: BinItem["kind"]
  readonly target_id: string
  readonly chat_id: string | null
  readonly title: string
  readonly excerpt: string
  readonly card_doc_json?: string | null
  readonly origin_json: string
  readonly byte_size: number
  readonly deleted_at: number
}

export const toBinItem = (row: BinRow) =>
  new BinItem({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    title: row.card_doc_json ? String(JSON.parse(row.card_doc_json).name ?? "") : row.title,
    excerpt: row.excerpt,
    origin: {
      ...(JSON.parse(row.origin_json) as Record<string, unknown>),
      ...(row.card_doc_json ? { subtitle: JSON.parse(row.card_doc_json).character_version ?? "" } : {})
    },
    byteSize: row.byte_size,
    deletedAt: row.deleted_at
  })

interface RecoveredRow {
  readonly id: string
  readonly source_kind: RecoveredText["sourceKind"]
  readonly source_id: string
  readonly source_field: string
  readonly source_label: string
  readonly reason: RecoveredText["reason"]
  readonly content: string
  readonly created_at: number
}

export const toRecoveredText = (row: RecoveredRow, full: boolean) =>
  new RecoveredText({
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceField: row.source_field,
    sourceLabel: row.source_label,
    reason: row.reason,
    content: full ? row.content : excerpt(row.content, 200),
    length: row.content.length,
    createdAt: row.created_at
  })

/** Eviction can't bring the bin within its limits. */
class NoRoom extends Data.TaggedError("NoRoom") {}

const chatName = (title: string | null | undefined) => (title ? `"${title}"` : "an untitled chat")

const bytes = (column: string) => `coalesce(length(CAST(${column} AS BLOB)), 0)`

/** The bytes deleting version `v` for good frees: what purgeVersions empties or deletes. */
const versionBytes = (v: string) =>
  [
    ...["content", "reasoning", "display_form", "context_form", "direction", "frozen_macros"].map((column) =>
      bytes(`${v}.${column}`)
    ),
    `(SELECT coalesce(sum(${bytes("h.content")}), 0) FROM version_history h WHERE h.version_id = ${v}.id)`,
    `(SELECT coalesce(sum(${bytes("a.alt_text")}), 0) FROM version_attachments a WHERE a.version_id = ${v}.id)`
  ].join(" + ")

/** What deleting a chat for good frees besides its versions, each part selected by chat id. */
const chatRecordBytes = [
  `SELECT ${bytes("value_json")} AS n FROM state_events WHERE chat_id = ?`,
  `SELECT ${bytes("error")} + ${bytes("cache_observed_json")} FROM rollouts WHERE chat_id = ?`,
  `SELECT ${bytes("p.context_snapshot_json")} + ${bytes("p.transcript_json")} + ${bytes("p.sent_context_json")}
   FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id WHERE r.chat_id = ?`,
  `SELECT ${bytes("b.messages_json")} FROM rollout_branches b JOIN rollouts r ON r.id = b.rollout_id WHERE r.chat_id = ?`,
  `SELECT ${bytes("v.content")} FROM summary_revisions v JOIN summaries s ON s.id = v.summary_id WHERE s.chat_id = ?`,
  `SELECT ${bytes("best_effort_draft")} + ${bytes("error")} FROM summarization_jobs WHERE chat_id = ?`,
  `SELECT ${bytes("i.before_json")} + ${bytes("i.after_json")}
   FROM changeset_items i JOIN changesets c ON c.id = i.changeset_id WHERE c.chat_id = ?`
]

export const makeBin = (sql: SqlClient.SqlClient, limits: BinLimits, now: () => number = Date.now) => {
  const insertItem = (item: {
    readonly userId: UserId
    readonly kind: BinItem["kind"]
    readonly targetId: string
    readonly chatId: string | null
    readonly title: string
    readonly excerpt: string
    readonly origin: Record<string, unknown>
    readonly byteSize: number
  }) =>
    Effect.gen(function* () {
      const id = uuidv7()
      yield* sql`INSERT INTO bin_items ${sql.insert({
        id,
        user_id: item.userId,
        kind: item.kind,
        target_id: item.targetId,
        chat_id: item.chatId,
        title: item.title,
        excerpt: excerpt(item.excerpt, 200),
        origin_json: JSON.stringify(item.origin),
        byte_size: item.byteSize,
        deleted_at: Date.now()
      })}`
      return id
    })

  const loadItem = (userId: UserId, itemId: string) =>
    sql<BinRow>`SELECT * FROM bin_items WHERE id = ${itemId} AND user_id = ${userId}`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "bin item", id: itemId }))
      )
    )

  /**
   * Every live fork of the chat whose tip is deleted in its own view moves it to the nearest
   * ancestor that isn't (each fork's composer is its own, so nothing moves with it).
   */
  const relocateLeaf = (chatId: string) =>
    Effect.gen(function* () {
      const forks = yield* sql<{ id: string; tip_slot_id: string }>`
        SELECT f.id, f.tip_slot_id FROM forks f JOIN slots t ON t.id = f.tip_slot_id
        WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND ${slotDeletedIn(sql, sql.literal("f.id"), "t")}`
      for (const fork of forks) {
        const [target] = yield* sql<{ id: string | null }>`
          WITH RECURSIVE up(id, parent, deleted, n) AS (
            SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, 0 FROM slots s WHERE s.id = ${fork.tip_slot_id}
            UNION ALL
            SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, up.n + 1 FROM slots s JOIN up ON s.id = up.parent
            WHERE up.deleted
          )
          SELECT (SELECT id FROM up WHERE NOT deleted ORDER BY n LIMIT 1) AS id`
        yield* sql`UPDATE forks SET tip_slot_id = ${target?.id ?? null}, row_version = row_version + 1
          WHERE id = ${fork.id}`
      }
    })

  /**
   * The live forks of the chat whose tip nothing continues below: no child that's live, or
   * deleted alone with replies left (what a path follows). Includes one before the first
   * message, which a restored first message continues. For restoring what was deleted
   * before forks kept their own deletions.
   */
  const tipForks = (chatId: string) =>
    sql<{ id: string; tip_slot_id: string | null }>`
      SELECT f.id, f.tip_slot_id FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM slots x WHERE x.chat_id = f.chat_id AND x.parent_slot_id IS f.tip_slot_id
          AND ${sql.literal(reachableSlot("x"))})`

  /** The end of the line below `slotId` (itself if nothing continues it): its newest reply at each step. */
  const latestBelow = (chatId: string, slotId: string | null) =>
    Effect.map(
      sql<{ id: string }>`
        WITH RECURSIVE down(id, n) AS (
          SELECT ${slotId}, 0
          UNION ALL
          SELECT (SELECT c.id FROM slots c WHERE c.chat_id = ${chatId} AND c.parent_slot_id IS d.id
              AND ${sql.literal(reachableSlot("c"))}
              ORDER BY c.id DESC LIMIT 1),
            d.n + 1
          FROM down d WHERE d.id IS NOT NULL OR d.n = 0
        )
        SELECT id FROM down WHERE id IS NOT NULL ORDER BY n DESC LIMIT 1`,
      ([row]) => row?.id ?? null
    )

  /**
   * After a restore: a fork whose tip was a tip follows what came back below it, on the
   * newest reply at each step, so a message deleted from the end of a fork is at its end again.
   */
  const followRestored = (chatId: string, fork: { id: string; tip_slot_id: string | null }) =>
    Effect.gen(function* () {
      const tip = yield* latestBelow(chatId, fork.tip_slot_id)
      if (tip !== null && tip !== fork.tip_slot_id)
        yield* sql`UPDATE forks SET tip_slot_id = ${tip}, row_version = row_version + 1 WHERE id = ${fork.id}`
    })

  /** A current fork that's in the bin is replaced by the live one most recently current. */
  const replaceCurrentFork = (chatId: string) =>
    Effect.gen(function* () {
      const [next] = yield* sql<{ id: string }>`
        SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE c.id = ${chatId} AND f.deleted_at IS NULL
          AND (SELECT deleted_at FROM forks WHERE id = c.current_fork_id) IS NOT NULL
        ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC LIMIT 1`
      if (next) yield* sql`UPDATE chats SET current_fork_id = ${next.id} WHERE id = ${chatId}`
    })

  // --- Deleting -----------------------------------------------------------------------
  // What a user deletes is deleted in a fork: an override of that fork's own (spec/FORK-INDEPENDENCE-
  // DELTA.md §2.4), so another fork still shows it. Only when no live fork shows it does the
  // slot or version carry the mark too (`slots.deleted_at` under the item), which keeps what reads
  // the marks (alternates in the switcher, tips following restores) as it was before forks.

  /** The fork a delete is in: `forkId`, else the one through the slot; a live fork of the chat. */
  const deletingFork = (chatId: string, slotId: string, forkId: string | null | undefined) =>
    Effect.gen(function* () {
      const id = forkId ?? (yield* forkAt(sql, chatId, slotId))
      const [fork] = yield* sql<ForkRow>`
        SELECT * FROM forks WHERE id = ${id} AND chat_id = ${chatId} AND deleted_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: id ?? chatId })
      return fork
    })

  const ownedLiveSlot = (userId: UserId, slotId: string, forkId: string | null | undefined) =>
    Effect.gen(function* () {
      const [owned] = yield* sql<{ chat_id: string }>`
        SELECT s.chat_id FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND s.purged_at IS NULL
          AND c.deleted_at IS NULL`
      if (!owned) return yield* new NotFound({ entity: "slot", id: slotId })
      const fork = yield* deletingFork(owned.chat_id, slotId, forkId)
      const [row] = yield* sql<{
        id: string
        chat_id: string
        depth: number
        parent_slot_id: string | null
        title: string
        content: string
      }>`
        SELECT s.id, s.chat_id, s.depth, s.parent_slot_id, c.title, v.content
        FROM slots s JOIN chats c ON c.id = s.chat_id JOIN versions v ON v.id = ${shownIn(sql, fork.id, "s")}
        WHERE s.id = ${slotId} AND NOT ${slotDeletedIn(sql, fork.id, "s")}`
      if (!row) return yield* new NotFound({ entity: "slot", id: slotId })
      return { ...row, fork }
    })

  const forkOrigin = (fork: ForkRow) => ({ forkId: fork.id, forkName: fork.name })

  const deleteMessage = (userId: UserId, slotId: string, forkId?: string | null) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId, forkId)
      const [size] = yield* sql<{ n: number }>`
        SELECT coalesce(sum(${sql.literal(versionBytes("v"))}), 0) AS n FROM versions v
        WHERE v.slot_id = ${slotId} AND v.deleted_at IS NULL`
      const itemId = yield* insertItem({
        userId,
        kind: "message",
        targetId: slotId,
        chatId: slot.chat_id,
        title: `Message in ${chatName(slot.title)}`,
        excerpt: slot.content,
        origin: {
          chatId: slot.chat_id,
          chatTitle: slot.title,
          slotId,
          depth: slot.depth,
          parentSlotId: slot.parent_slot_id,
          ...forkOrigin(slot.fork)
        },
        byteSize: size!.n
      })
      yield* writeOverride(
        sql,
        { id: slot.fork.id, chatId: slot.chat_id },
        { kind: "delete_slot", targetId: slotId, slotId, valueId: null, flag: 1, binItemId: itemId }
      )
      yield* recordReduction(sql, slotId, slot.fork.id)
      const shown = yield* forksShowing(sql, slot.chat_id, slotId, null, slot.fork.id, false)
      if (shown.length === 0)
        yield* sql`UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${slotId}`
      yield* relocateLeaf(slot.chat_id)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${slot.chat_id}`
      return itemId
    })

  /**
   * Deletes one fork (owner, 2026-10-27): only that fork goes, and forks made from it keep
   * their shared history. The fork is marked and its bin item names it. The messages of its
   * path that no other live fork shows are marked under the item (so they leave the
   * switcher and a purge can empty them); the rest stay, shown by the forks that have them.
   */
  const deleteFork = (userId: UserId, forkId: string) =>
    Effect.gen(function* () {
      const [fork] = yield* sql<ForkRow & { chat_title: string }>`
        SELECT f.*, c.title AS chat_title FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND f.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
      const others = yield* sql<{ tip_slot_id: string | null; deleted_at: number | null }>`
        SELECT tip_slot_id, deleted_at FROM forks WHERE chat_id = ${fork.chat_id} AND purged_at IS NULL AND id <> ${forkId}`
      if (!others.some((other) => other.deleted_at === null)) return yield* new CannotDeleteLastFork()
      const below =
        fork.tip_slot_id === null
          ? Number.MAX_SAFE_INTEGER
          : (yield* sharedDepth(
              sql,
              fork.chat_id,
              fork.tip_slot_id,
              others.flatMap((other) => (other.tip_slot_id === null ? [] : [other.tip_slot_id]))
            )) + 1
      const unseen = (statement: "count" | "mark", itemId = "") =>
        fork.tip_slot_id === null
          ? Effect.succeed([{ slots: 0, bytes: 0 }])
          : statement === "count"
            ? sql<{ slots: number; bytes: number }>`
                ${pathSegments(sql, fork.chat_id, fork.tip_slot_id, null)}
                SELECT count(DISTINCT s.id) AS slots, coalesce(sum(${sql.literal(versionBytes("v"))}), 0) AS bytes
                FROM segments g JOIN slots s ON s.chain_id = g.chain_id AND s.depth BETWEEN max(g.lo, ${below}) AND g.hi
                  LEFT JOIN versions v ON v.slot_id = s.id AND v.deleted_at IS NULL
                WHERE s.deleted_at IS NULL`
            : sql<{ slots: number; bytes: number }>`
                ${pathSegments(sql, fork.chat_id, fork.tip_slot_id, null)}
                UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}
                WHERE deleted_at IS NULL AND id IN (SELECT s.id FROM segments g JOIN slots s ON s.chain_id = g.chain_id
                  AND s.depth BETWEEN max(g.lo, ${below}) AND g.hi)
                RETURNING 0 AS slots, 0 AS bytes`
      const [stats] = yield* unseen("count")
      const [tip] = yield* sql<{ content: string }>`
        SELECT v.content FROM slots t JOIN versions v ON v.id = ${shownIn(sql, forkId, "t")} WHERE t.id = ${fork.tip_slot_id}`
      const itemId = yield* insertItem({
        userId,
        kind: "branch",
        targetId: forkId,
        chatId: fork.chat_id,
        title: `Fork of ${stats!.slots} message${stats!.slots === 1 ? "" : "s"} in ${chatName(fork.chat_title)}`,
        excerpt: tip?.content ?? "",
        origin: {
          chatId: fork.chat_id,
          chatTitle: fork.chat_title,
          slotId: fork.tip_slot_id,
          parentSlotId: fork.base_slot_id,
          messages: stats!.slots,
          ...forkOrigin(fork)
        },
        byteSize: stats!.bytes
      })
      yield* unseen("mark", itemId)
      // The head of what it marked is a barrier, as a deleted branch's root always was: a message
      // deleted on its own below it that's restored later doesn't bring the fork's slots back.
      yield* sql`UPDATE slots SET branch_deleted = 1 WHERE bin_item_id = ${itemId}
        AND NOT EXISTS (SELECT 1 FROM slots p WHERE p.id = slots.parent_slot_id AND p.bin_item_id = slots.bin_item_id)`
      yield* sql`UPDATE forks SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}, row_version = row_version + 1
        WHERE id = ${forkId}`
      yield* replaceCurrentFork(fork.chat_id)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${fork.chat_id}`
      return itemId
    })

  /**
   * Deletes one swipe in a fork. The only remaining version of a message in the fork takes the
   * message with it. A fork's copy standing in for a version (schema/forkVersions.ts) is deleted
   * as that version.
   */
  const deleteVersion = (userId: UserId, shownId: string, forkId?: string | null) =>
    Effect.gen(function* () {
      const [version] = yield* sql<{
        id: string
        slot_id: string
        chat_id: string
        ordinal: number
        content: string
        bytes: number
      }>`
        SELECT o.id, o.slot_id, s.chat_id, o.ordinal, x.content,
          ${sql.literal(versionBytes("o"))} + (SELECT coalesce(sum(${sql.literal(versionBytes("c"))}), 0)
            FROM versions c WHERE c.source_version_id = o.id AND c.fork_id IS NOT NULL) AS bytes
        FROM versions x JOIN versions o ON o.id = ${sql.literal(originalSql("x"))}
          JOIN slots s ON s.id = o.slot_id JOIN chats c ON c.id = s.chat_id
        WHERE x.id = ${shownId} AND c.owner_user_id = ${userId}
          AND o.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!version) return yield* new NotFound({ entity: "version", id: shownId })
      const versionId = version.id
      const fork = yield* deletingFork(version.chat_id, version.slot_id, forkId)
      const others = yield* sql<{ id: string; ordinal: number }>`
        SELECT o.id, o.ordinal FROM versions o WHERE o.slot_id = ${version.slot_id} AND o.id <> ${versionId}
          AND o.fork_id IS NULL AND NOT ${versionDeletedIn(sql, fork.id, "o")}
        ORDER BY o.ordinal`
      const [here] = yield* sql<{ gone: number }>`
        SELECT (${versionDeletedIn(sql, fork.id, "o")} OR ${slotDeletedIn(sql, fork.id, "s")}) AS gone
        FROM versions o JOIN slots s ON s.id = o.slot_id WHERE o.id = ${versionId}`
      if (here!.gone) return yield* new NotFound({ entity: "version", id: shownId })
      if (others.length === 0) return yield* deleteMessage(userId, version.slot_id, fork.id)
      const slot = yield* ownedLiveSlot(userId, version.slot_id, fork.id)
      const itemId = yield* insertItem({
        userId,
        kind: "version",
        targetId: versionId,
        chatId: slot.chat_id,
        title: `Version of a message in ${chatName(slot.title)}`,
        excerpt: version.content,
        origin: {
          chatId: slot.chat_id,
          chatTitle: slot.title,
          slotId: slot.id,
          depth: slot.depth,
          ordinal: version.ordinal,
          ...forkOrigin(fork)
        },
        byteSize: version.bytes
      })
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: slot.chat_id },
        { kind: "delete_version", targetId: versionId, slotId: slot.id, valueId: null, flag: 1, binItemId: itemId }
      )
      // Like ST, the fork shows the previous swipe if it showed this one, or the next one if
      // this was the first.
      const [selected] = yield* sql<{
        id: string
      }>`SELECT ${selectedIn(sql, fork.id, "s")} AS id FROM slots s WHERE s.id = ${slot.id}`
      if (selected!.id === versionId) {
        const previous = others.filter((o) => o.ordinal < version.ordinal).at(-1) ?? others[0]!
        yield* writeSelect(sql, { id: fork.id, chatId: slot.chat_id }, slot.id, previous.id)
        yield* recordReduction(sql, slot.id, fork.id)
      }
      const shown = yield* forksShowing(sql, slot.chat_id, slot.id, versionId, fork.id, false)
      if (shown.length === 0) {
        yield* sql`UPDATE versions SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${versionId}`
      }
      return itemId
    })

  const deleteChat = (userId: UserId, chatId: string) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{ id: string; title: string }>`
        SELECT id, title FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
      // Messages and swipes already in the bin count under their own items.
      const [stats] = yield* sql<{ bytes: number; last: string | null; messages: number }>`
        SELECT coalesce(sum(CASE WHEN s.deleted_at IS NULL AND v.deleted_at IS NULL
                 THEN ${sql.literal(versionBytes("v"))} END), 0) AS bytes,
          count(DISTINCT s.id) AS messages,
          (SELECT v2.content FROM chats c2 JOIN slots s2 ON s2.id = c2.active_leaf_slot_id
             JOIN versions v2 ON v2.id = ${sql.literal(shownInSql("c2.current_fork_id", "s2"))}
             WHERE c2.id = ${chatId}) AS last
        FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ${chatId}`
      const [records] = yield* sql.unsafe<{ n: number }>(
        `SELECT coalesce(sum(n), 0) AS n FROM (${chatRecordBytes.join(" UNION ALL ")})`,
        chatRecordBytes.map(() => chatId)
      )
      const itemId = yield* insertItem({
        userId,
        kind: "chat",
        targetId: chatId,
        chatId,
        title: chat.title || "Untitled chat",
        excerpt: stats?.last ?? "",
        origin: { chatId, messages: stats?.messages ?? 0 },
        byteSize: (stats?.bytes ?? 0) + records!.n
      })
      yield* sql`UPDATE chats SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}, row_version = row_version + 1 WHERE id = ${chatId}`
      return itemId
    })

  const deleteEntity = (userId: UserId, entityId: string) =>
    Effect.gen(function* () {
      const [entity] = yield* sql<{ id: string; kind: string; label: string | null; bytes: number }>`
        SELECT e.id, e.kind,
          (SELECT label FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1) AS label,
          (SELECT coalesce(sum(${sql.literal(`${bytes("doc_json")} + ${bytes("search_text")}`)}), 0) FROM entity_revisions WHERE entity_id = e.id) AS bytes
        FROM entities e WHERE e.id = ${entityId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`
      if (!entity) return yield* new NotFound({ entity: "entity", id: entityId })
      const itemId = yield* insertItem({
        userId,
        kind: "entity",
        targetId: entityId,
        chatId: null,
        title: entity.label ?? `Untitled ${entity.kind}`,
        excerpt: entity.kind,
        origin: { entityId, kind: entity.kind, label: entity.label },
        byteSize: entity.bytes
      })
      yield* sql`UPDATE entities SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${entityId}`
      return itemId
    })

  const deleteConnection = (userId: UserId, connectionId: string) =>
    Effect.gen(function* () {
      const [connection] = yield* sql<{ name: string; kind: string }>`
        SELECT name, kind FROM connections
        WHERE id = ${connectionId} AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`
      if (!connection) return yield* new NotFound({ entity: "connection", id: connectionId })
      const itemId = yield* insertItem({
        userId,
        kind: "connection",
        targetId: connectionId,
        chatId: null,
        title: connection.name,
        excerpt: connection.kind,
        origin: { connectionId, kind: connection.kind },
        byteSize: 0
      })
      yield* sql`UPDATE connections SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${connectionId}`
      return itemId
    })

  // --- Restoring and deleting for good -----------------------------------------------

  /** SQL: bin items that name the fork a deletion was in (`origin_json.forkId`). */
  const forkItems = `SELECT id FROM bin_items WHERE origin_json ->> '$.forkId' IS NOT NULL`

  /**
   * Restores what was deleted in a fork (`deleteMessage`, `deleteVersion`, `deleteFork`): the
   * fork's own row says it's back, and a mark the writer put on the slot or version under a
   * fork's item (it was shown by no live fork) is cleared, since a fork may show it again. The
   * other forks never lost anything.
   */
  const restoreInFork = (item: BinRow, forkId: string) =>
    Effect.gen(function* () {
      const chatId = item.chat_id!
      const [fork] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${forkId} AND purged_at IS NULL`
      // Everything marked under the item, an ST import's copies of it included (§13).
      yield* sql`UPDATE slots SET deleted_at = NULL, bin_item_id = NULL, branch_deleted = 0 WHERE bin_item_id = ${item.id}
        AND purged_at IS NULL`
      yield* sql`UPDATE versions SET deleted_at = NULL, bin_item_id = NULL WHERE bin_item_id = ${item.id}
        AND purged_at IS NULL`
      if (item.kind === "branch") {
        yield* sql`UPDATE forks SET deleted_at = NULL, bin_item_id = NULL, row_version = row_version + 1
          WHERE id = ${forkId}`
        // Every message on its path is shown by it again, whoever's deletion marked it.
        if (fork?.tip_slot_id) {
          const onItsPath = sql`SELECT s.id FROM segments g JOIN slots s ON s.chain_id = g.chain_id
            AND s.depth BETWEEN g.lo AND g.hi`
          yield* sql`${pathSegments(sql, chatId, fork.tip_slot_id, null)}
            UPDATE slots SET deleted_at = NULL, bin_item_id = NULL, branch_deleted = 0 WHERE id IN (${onItsPath}) AND deleted_at IS NOT NULL
              AND purged_at IS NULL AND bin_item_id IN (${sql.literal(forkItems)})`
          yield* sql`${pathSegments(sql, chatId, fork.tip_slot_id, null)}
            UPDATE versions SET deleted_at = NULL, bin_item_id = NULL
            WHERE slot_id IN (${onItsPath}) AND deleted_at IS NOT NULL AND purged_at IS NULL
              AND bin_item_id IN (${sql.literal(forkItems)})`
        }
      } else if (item.kind === "message" || item.kind === "version") {
        const slotId = JSON.parse(item.origin_json).slotId as string
        const target = item.target_id
        if (fork)
          yield* writeOverride(
            sql,
            { id: fork.id, chatId },
            {
              kind: item.kind === "message" ? "delete_slot" : "delete_version",
              targetId: target,
              slotId,
              valueId: null,
              flag: 0
            }
          )
        const table = item.kind === "message" ? "slots" : "versions"
        yield* sql.unsafe(
          `UPDATE ${table} SET deleted_at = NULL, bin_item_id = NULL WHERE id = ? AND deleted_at IS NOT NULL
             AND purged_at IS NULL AND bin_item_id IN (${forkItems})`,
          [target]
        )
        let restoredMessage = item.kind === "message"
        if (item.kind === "version" && fork) {
          // A global purge can remove this fork's last available alternative. Its automatic
          // slot deletion records the purged selection in value_id, unlike a user's deletion.
          const [automatic] = yield* sql`SELECT 1 FROM slots s JOIN fork_overrides o
            ON o.id = ${effectiveOverride(sql, "delete_slot", fork.id, "s.id")}
            WHERE s.id = ${slotId} AND o.flag = 1 AND o.value_id IS NOT NULL`
          if (automatic) {
            yield* writeOverride(
              sql,
              { id: fork.id, chatId },
              {
                kind: "delete_slot",
                targetId: slotId,
                slotId,
                valueId: null,
                flag: 0
              }
            )
            yield* writeSelect(sql, { id: fork.id, chatId }, slotId, target)
            restoredMessage = true
          }
        }
        if (restoredMessage && fork && fork.deleted_at === null) {
          // The fork's tip followed the delete up. If it's still where it went, it follows the
          // message back down. If the fork went on, the message isn't on its path any more, and
          // comes back as a fork of its own, from the fork, at its parent (§2.4).
          const [slot] = yield* sql<{
            parent_slot_id: string | null
          }>`SELECT parent_slot_id FROM slots WHERE id = ${slotId}`
          if (!(yield* onPath(sql, chatId, fork.tip_slot_id, slotId))) {
            const tip = slotId
            if (fork.tip_slot_id === (slot?.parent_slot_id ?? null)) {
              yield* sql`UPDATE forks SET tip_slot_id = ${tip}, row_version = row_version + 1 WHERE id = ${fork.id}`
            } else {
              yield* insertFork(sql, {
                chatId,
                parent: fork,
                baseSlotId: slot?.parent_slot_id ?? null,
                tipSlotId: tip,
                at: Date.now()
              })
            }
          }
        }
      }
    })

  const restore = (userId: UserId, itemId: string) =>
    Effect.gen(function* () {
      const item = yield* loadItem(userId, itemId)
      const forkId = (JSON.parse(item.origin_json) as { forkId?: string }).forkId
      if (forkId !== undefined && item.chat_id !== null) {
        yield* discardDeletedQueue(item.chat_id)
        yield* restoreInFork(item, forkId)
        yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
        yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${item.chat_id}`
        return toBinItem(item)
      }
      // A deleted message took tips up to its parent (relocateLeaf): they come back down. A
      // restored branch brings back its own forks as they were, and a chat's last fork, kept
      // when its branch went, comes back down too.
      const messages = item.kind === "message" || item.kind === "branch"
      const tips = messages && item.chat_id !== null ? yield* tipForks(item.chat_id) : []
      if (item.chat_id !== null) yield* discardDeletedQueue(item.chat_id)
      const table = {
        chat: "chats",
        message: "slots",
        branch: "slots",
        version: "versions",
        entity: "entities",
        connection: "connections"
      }[item.kind]
      // An import's copy of a deleted branch root carries the item and the root's marker too.
      if (item.kind === "branch") {
        yield* sql`UPDATE slots SET branch_deleted = 0 WHERE bin_item_id = ${itemId} AND branch_deleted = 1`
        yield* sql`UPDATE forks SET deleted_at = NULL, bin_item_id = NULL, row_version = row_version + 1
          WHERE bin_item_id = ${itemId}`
      }
      yield* sql.unsafe(`UPDATE ${table} SET deleted_at = NULL, bin_item_id = NULL WHERE bin_item_id = ?`, [itemId])
      yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
      if ((messages || item.kind === "chat") && item.chat_id !== null) {
        yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${item.chat_id}`
      }
      for (const fork of tips) yield* followRestored(item.chat_id!, fork)
      return toBinItem(item)
    })

  /**
   * `versionId` is going for good: every fork of the chat that selects it selects another swipe of
   * the message that it still shows, or, with none left, deletes the message in its own view.
   */
  const dropSelections = (chatId: string, slotId: string, versionId: string) =>
    Effect.gen(function* () {
      const [gone] = yield* sql<{ ordinal: number }>`SELECT ordinal FROM versions WHERE id = ${versionId}`
      const forks = yield* sql<{ id: string }>`
        SELECT f.id FROM forks f JOIN slots s ON s.id = ${slotId}
        WHERE f.chat_id = ${chatId} AND ${selectedIn(sql, sql.literal("f.id"), "s")} = ${versionId}`
      for (const fork of forks) {
        const left = yield* sql<{ id: string; ordinal: number }>`
          SELECT o.id, o.ordinal FROM versions o WHERE o.slot_id = ${slotId} AND o.id <> ${versionId}
            AND o.fork_id IS NULL AND NOT ${versionDeletedIn(sql, fork.id, "o")} ORDER BY o.ordinal`
        const next = left.filter((o) => o.ordinal < gone!.ordinal).at(-1) ?? left[0]
        if (next) yield* writeSelect(sql, { id: fork.id, chatId }, slotId, next.id)
        else
          yield* writeOverride(
            sql,
            { id: fork.id, chatId },
            { kind: "delete_slot", targetId: slotId, slotId, valueId: versionId, flag: 1 }
          )
      }
      yield* relocateLeaf(chatId)
    })

  /**
   * Deletes for good the bin items `where` (a condition on bin_items, with its `params`)
   * selects. Set-based, so emptying a large bin takes a few statements, not a few per item.
   */
  const purgeWhere = (where: string, params: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const chats = yield* sql.unsafe<{ chat_id: string }>(
        `SELECT DISTINCT chat_id FROM bin_items WHERE chat_id IS NOT NULL AND (${where})`,
        params
      )
      for (const chat of chats) yield* discardDeletedQueue(chat.chat_id)
      const now = Date.now()
      const run = (statement: string, leading: ReadonlyArray<unknown> = []) =>
        sql.unsafe(statement, [...leading, ...params])
      const targets = (kind: BinItem["kind"]) => `SELECT target_id FROM bin_items WHERE kind = '${kind}' AND (${where})`
      const items = (kinds: string) => `SELECT id FROM bin_items WHERE kind IN (${kinds}) AND (${where})`

      /** Empties versions and drops what refers to them, including swipes binned separately inside. */
      const purgeVersions = (versions: string) =>
        Effect.gen(function* () {
          yield* run(
            `UPDATE versions SET purged_at = ?, content = '', reasoning = NULL, display_form = NULL,
               context_form = NULL, direction = NULL, frozen_macros = NULL
             WHERE ${versions}`,
            [now]
          )
          yield* run(`DELETE FROM version_history WHERE version_id IN (SELECT id FROM versions WHERE ${versions})`)
          yield* run(`DELETE FROM version_attachments WHERE version_id IN (SELECT id FROM versions WHERE ${versions})`)
          yield* run(
            `DELETE FROM bin_items WHERE kind = 'version' AND target_id IN (SELECT id FROM versions WHERE ${versions})`
          )
        })

      // What was deleted in a fork is erased everywhere (owner, 2026-10-27, Q3 (b)): the client
      // warned which forks show it first (`BinItemForks`). The message or swipe is marked under
      // the item, so the purge below empties it; forks that showed a swipe select another, or
      // delete the message in their own view when it was its last.
      const forkOwned = (kind: "message" | "version") =>
        sql.unsafe<{ id: string; chat_id: string; target_id: string; slot_id: string }>(
          `SELECT id, chat_id, target_id, origin_json ->> '$.slotId' AS slot_id FROM bin_items
           WHERE kind = '${kind}' AND origin_json ->> '$.forkId' IS NOT NULL AND chat_id IS NOT NULL AND (${where})`,
          params
        )
      const erasedMessages = yield* forkOwned("message")
      for (const item of erasedMessages) {
        yield* recordReduction(sql, item.target_id, null)
        yield* sql`UPDATE slots SET deleted_at = coalesce(deleted_at, ${now}), bin_item_id = ${item.id}
          WHERE id = ${item.target_id} AND purged_at IS NULL`
      }
      for (const item of yield* forkOwned("version")) {
        yield* recordReduction(sql, item.slot_id, null)
        yield* sql`UPDATE versions SET deleted_at = coalesce(deleted_at, ${now}), bin_item_id = ${item.id}
          WHERE id = ${item.target_id} AND purged_at IS NULL`
        yield* dropSelections(item.chat_id, item.slot_id, item.target_id)
      }

      // A chat goes with everything in it, its other bin items included. A connection
      // using one of its overrides as its preset loses that preset.
      yield* run(`UPDATE connections SET preset_override_ref_id = NULL
                  WHERE preset_override_ref_id IN (SELECT id FROM entity_refs WHERE chat_id IN (${targets("chat")}))`)
      yield* run(`DELETE FROM bin_items WHERE kind <> 'chat' AND chat_id IN (${targets("chat")})`)
      yield* run(`DELETE FROM chats WHERE id IN (${targets("chat")})`)

      // Messages and branches keep their slots as empty placeholders, so the
      // conversation's structure and any summaries over it remain valid. A branch's forks
      // keep their rows, losing their names and tips.
      yield* run(`UPDATE slots SET purged_at = ? WHERE bin_item_id IN (${items("'message', 'branch'")})`, [now])
      // The head of a purged fork's slots stays a barrier, as a purged branch's root always did.
      yield* run(
        `UPDATE slots SET branch_deleted = 1 WHERE bin_item_id IN (${items("'branch'")})
           AND NOT EXISTS (SELECT 1 FROM slots p WHERE p.id = slots.parent_slot_id AND p.bin_item_id = slots.bin_item_id)`
      )
      yield* run(
        `UPDATE forks SET purged_at = ?, name = NULL, tip_slot_id = NULL, bin_item_id = NULL, row_version = row_version + 1
         WHERE bin_item_id IN (${items("'branch'")})`,
        [now]
      )
      yield* purgeVersions(`slot_id IN (SELECT id FROM slots WHERE bin_item_id IN (${items("'message', 'branch'")}))`)
      // A swipe goes with every fork's copy standing in for it (schema/forkVersions.ts), first,
      // while the swipe's bin item still says which it is.
      yield* purgeVersions(
        `fork_id IS NOT NULL AND source_version_id IN (SELECT id FROM versions WHERE bin_item_id IN (${items("'version'")}))`
      )
      yield* purgeVersions(`bin_item_id IN (${items("'version'")})`)

      // An entity row stays, so messages that named it as their speaker still point somewhere.
      const entityRefs = `SELECT id FROM entity_refs WHERE entity_id IN (${targets("entity")})`
      yield* run(`UPDATE connections SET preset_override_ref_id = NULL WHERE preset_override_ref_id IN (${entityRefs})`)
      yield* run(`DELETE FROM entity_refs WHERE entity_id IN (${targets("entity")})`)
      yield* run(`DELETE FROM entity_tags WHERE entity_id IN (${targets("entity")})`)
      yield* run(`DELETE FROM entity_revisions WHERE entity_id IN (${targets("entity")})`)
      yield* run(`UPDATE entities SET purged_at = ? WHERE id IN (${targets("entity")})`, [now])

      // A key typed into a purged connection goes with it, unless another connection
      // (live or in the bin) uses it. Deleting it clears credential_id (ON DELETE SET NULL).
      yield* run(
        `DELETE FROM credentials WHERE connection_owned = 1
           AND id IN (SELECT credential_id FROM connections WHERE id IN (${targets("connection")}))
           AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.credential_id = credentials.id
             AND c.id NOT IN (${targets("connection")}))`,
        params
      )

      // A connection stays as a tombstone without secrets: old messages and ledger rows
      // still name their model (PROVIDERS §10).
      yield* run(
        `UPDATE connections SET purged_at = ?, credential_id = NULL, headers_enc = NULL, header_names_json = '[]',
           proxy_mode = 'inherit', proxy_url_enc = NULL, base_url = NULL
         WHERE id IN (${targets("connection")})`,
        [now]
      )

      yield* run(`DELETE FROM bin_items WHERE ${where}`)
      // A message erased everywhere has no other deletion left to restore, and a fork whose tip it
      // was goes up out of it.
      for (const item of erasedMessages)
        yield* sql`DELETE FROM bin_items WHERE kind = 'message' AND target_id = ${item.target_id}`
      for (const chatId of new Set(erasedMessages.map((item) => item.chat_id))) yield* relocateLeaf(chatId)
    })

  const confirmForks = (
    userId: UserId,
    itemIds: ReadonlyArray<string>,
    expectedForkIds: ReadonlyArray<string> | undefined
  ) =>
    Effect.gen(function* () {
      if (expectedForkIds === undefined) return
      const actual = new Set((yield* binItemForks(sql, userId, itemIds)).map((fork) => fork.forkId))
      const expected = new Set(expectedForkIds)
      if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) return yield* new BinChanged()
    })

  const purge = (userId: UserId, itemId: string, expectedForkIds?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const item = yield* loadItem(userId, itemId)
      yield* confirmForks(userId, [itemId], expectedForkIds)
      yield* purgeWhere("id = ?", [item.id])
      return item.chat_id === null ? [] : [item.chat_id]
    })

  const emptyBin = (userId: UserId, itemIds: ReadonlyArray<string>, expectedForkIds?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: string
        chat_id: string | null
      }>`SELECT id, chat_id FROM bin_items WHERE user_id = ${userId}`
      const confirmed = new Set(itemIds)
      if (rows.length !== confirmed.size || !rows.every((row) => confirmed.has(row.id))) {
        return yield* new BinChanged()
      }
      yield* confirmForks(userId, itemIds, expectedForkIds)
      // The comparison and purge share this writer transaction: every current item was confirmed.
      yield* purgeWhere("user_id = ?", [userId])
      return {
        purged: rows.length,
        chatIds: [...new Set(rows.flatMap((row) => (row.chat_id === null ? [] : [row.chat_id])))]
      }
    })

  /**
   * Keeps the deleted-items section within its limits by deleting the oldest items for
   * good, never `created`, the item the delete just made. Each purge runs in its own
   * savepoint: one that fails is rolled back, logged and skipped. If the items that can
   * go can't make room, nothing goes: the bin stays over its limits rather than losing
   * everything else to one delete, and later deletes or emptying it bring it back.
   */
  const evictDeleted = (userId: UserId, created: string) =>
    Effect.gen(function* () {
      const fits = sql<{ n: number; bytes: number }>`
        SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM bin_items WHERE user_id = ${userId}`.pipe(
        Effect.map(([usage]) => usage!.n <= limits.deletedItems && usage!.bytes <= limits.deletedBytes)
      )
      if (yield* fits) return
      const [newest] = yield* sql<{ byte_size: number }>`SELECT byte_size FROM bin_items WHERE id = ${created}`
      // Not even evicting everything else would make room.
      if (limits.deletedItems < 1 || newest!.byte_size > limits.deletedBytes) return
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            let after = { deleted_at: -1, id: "" }
            while (!(yield* fits)) {
              const [oldest] = yield* sql<BinRow>`
                SELECT * FROM bin_items
                WHERE user_id = ${userId} AND id <> ${created} AND (deleted_at, id) > (${after.deleted_at}, ${after.id})
                ORDER BY deleted_at, id LIMIT 1`
              if (!oldest) return yield* new NoRoom()
              after = oldest
              // Another deletion of the same content must remain restorable.
              const [protectedItem] = yield* sql`SELECT 1 FROM bin_items
                WHERE id <> ${oldest.id} AND chat_id = ${oldest.chat_id} AND (
                  (kind = ${oldest.kind} AND target_id = ${oldest.target_id}) OR
                  (kind IN ('message', 'version') AND origin_json ->> '$.slotId' = ${JSON.parse(oldest.origin_json).slotId ?? null}
                    AND (${oldest.kind} = 'message' OR kind = 'message')))`
              if (protectedItem && (oldest.kind === "message" || oldest.kind === "version")) continue
              // Making room never erases what another fork still shows: its deletion in its own
              // fork becomes permanent, and the item goes.
              const origin = JSON.parse(oldest.origin_json) as { forkId?: string; slotId?: string }
              if (
                origin.forkId !== undefined &&
                (oldest.kind === "message" || oldest.kind === "version") &&
                oldest.chat_id !== null
              ) {
                // A deleted fork, or a locally deleted message, can become visible again. Its
                // path still retains the content even when forksShowing quite correctly omits it.
                const others = yield* sql<{ tip_slot_id: string }>`SELECT tip_slot_id FROM forks
                  WHERE chat_id = ${oldest.chat_id} AND id <> ${origin.forkId} AND purged_at IS NULL
                    AND tip_slot_id IS NOT NULL`
                let retained = false
                for (const other of others) {
                  if (yield* onPath(sql, oldest.chat_id, other.tip_slot_id, origin.slotId!)) {
                    retained = true
                    break
                  }
                }
                if (retained) {
                  const [marked] = yield* sql`SELECT 1 FROM slots WHERE bin_item_id = ${oldest.id}
                    UNION ALL SELECT 1 FROM versions WHERE bin_item_id = ${oldest.id} LIMIT 1`
                  if (!marked) yield* sql`DELETE FROM bin_items WHERE id = ${oldest.id}`
                  continue
                }
              }
              yield* sql
                .withTransaction(purgeWhere("id = ?", [oldest.id]))
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`bin eviction skipped ${oldest.kind} item ${oldest.id}`, error.reason.cause)
                  )
                )
            }
          })
        )
        .pipe(Effect.catchTag("NoRoom", () => Effect.logWarning(`bin over capacity for ${userId}: nothing can go`)))
    })

  // --- Recovered text ------------------------------------------------------------------

  const sourceLabel = (key: DraftKey) =>
    Effect.gen(function* () {
      const chatTitle = (sqlText: string) =>
        sql.unsafe<{ title: string }>(sqlText, [key.targetId]).pipe(Effect.map(([row]) => chatName(row?.title)))
      switch (key.targetKind) {
        case "composer":
          return `Composer in ${yield* chatTitle(`SELECT title FROM chats WHERE id = ?`)}`
        case "version_edit":
          return `Edit of a message in ${yield* chatTitle(
            `SELECT c.title FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id WHERE v.id = ?`
          )}`
        case "scratchpad":
          return `Scratchpad in ${yield* chatTitle(`SELECT c.title FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ?`)}`
        case "summary_edit":
          return `Summary in ${yield* chatTitle(`SELECT c.title FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.id = ?`)}`
        case "entity_field": {
          const [ref] = yield* sql<{ label: string }>`SELECT label FROM entity_refs WHERE id = ${key.targetId}`
          return [ref?.label ?? "A library entry", key.field].filter(Boolean).join(" › ")
        }
      }
    })

  /** Saves draft text that a commit or discard would otherwise lose. Never shown as a toast. */
  const recover = (userId: UserId, key: DraftKey, texts: ReadonlyArray<string>, reason: "commit" | "discard") =>
    Effect.gen(function* () {
      // `texts` come newest first; inserting oldest first keeps "newest first" listings right.
      const unique = [...new Set(texts)].filter((t) => t.trim().length > 0).reverse()
      if (unique.length === 0) return
      const label = yield* sourceLabel(key)
      const now = Date.now()
      for (const content of unique) {
        yield* sql`INSERT INTO recovered_texts ${sql.insert({
          id: uuidv7(),
          user_id: userId,
          source_kind: key.targetKind,
          source_id: key.targetId,
          source_field: key.field,
          source_label: label,
          reason,
          content,
          byte_size: Buffer.byteLength(content),
          created_at: now
        })}`
      }
      // Its own track: recovered text never evicts deleted items, or the other way round.
      const rows = yield* sql<{ id: string; byte_size: number }>`
        SELECT id, byte_size FROM recovered_texts WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC`
      let bytes = 0
      const cut = rows.findIndex((row, index) => {
        bytes += row.byte_size
        return index >= limits.recoveredTexts || bytes > limits.recoveredBytes
      })
      if (cut >= 0) {
        for (const row of rows.slice(cut)) yield* sql`DELETE FROM recovered_texts WHERE id = ${row.id}`
      }
    })

  /** Keeps every unposted entry's text, including a Generate's one-turn direction. */
  const recoverQueued = (userId: UserId, entries: ReadonlyArray<QueuedRow>) =>
    Effect.gen(function* () {
      for (const entry of entries) {
        yield* recover(
          userId,
          composerKey(entry.chat_id, entry.fork_id),
          [entry.content, entry.direction ?? ""],
          "discard"
        )
      }
    })

  // A restore or purge can precede the generation's cleanup (or follow a crash).
  const discardDeletedQueue = (chatId: string) =>
    Effect.gen(function* () {
      const entries = yield* sql<QueuedRow & { owner_user_id: UserId }>`
        SELECT q.*, c.owner_user_id FROM queued_messages q JOIN chats c ON c.id = q.chat_id
          JOIN slots s ON s.id = q.reply_slot_id
        WHERE q.chat_id = ${chatId} AND (c.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL) ORDER BY q.seq`
      if (entries.length === 0) return
      yield* recoverQueued(entries[0]!.owner_user_id, entries)
      yield* sql`DELETE FROM queued_messages WHERE ${sql.in(
        "id",
        entries.map((entry) => entry.id)
      )}`
    })

  const drafts = makeDraftStore(sql, recover, now)

  return {
    drafts,
    deleteChat,
    deleteMessage,
    deleteFork,
    deleteVersion,
    deleteEntity,
    deleteConnection,
    restore,
    purge,
    emptyBin,
    evictDeleted,
    loadItem,
    recover,
    recoverQueued
  }
}

export type Bin = ReturnType<typeof makeBin>
